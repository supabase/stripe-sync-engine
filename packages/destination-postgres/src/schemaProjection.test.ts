import { describe, expect, it } from 'vitest'
import {
  jsonSchemaToColumns,
  buildCreateTableWithSchema,
  buildCreateTableDDL,
} from './schemaProjection.js'

const SAMPLE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    created: { type: 'integer' },
    deleted: { type: 'boolean' },
    metadata: { type: 'object' },
    expires_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'created'],
  'x-source-schema': 'customer',
}

const EXPANDABLE_REF_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    customer: { type: 'object', 'x-expandable-reference': true },
  },
  required: ['id'],
}

describe('jsonSchemaToColumns', () => {
  it('maps JSON Schema types to pg column defs', () => {
    const columns = jsonSchemaToColumns(SAMPLE_JSON_SCHEMA)
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]))

    expect(byName.created.pgType).toBe('bigint')
    expect(byName.deleted.pgType).toBe('boolean')
    expect(byName.metadata.pgType).toBe('jsonb')
    expect(byName.expires_at.pgType).toBe('text') // date-time → text for safety
  })

  it('skips the id column (generated separately)', () => {
    const columns = jsonSchemaToColumns(SAMPLE_JSON_SCHEMA)
    expect(columns.find((c) => c.name === 'id')).toBeUndefined()
  })

  it('handles expandable references as text with CASE expression', () => {
    const columns = jsonSchemaToColumns(EXPANDABLE_REF_SCHEMA)
    const customerCol = columns.find((c) => c.name === 'customer')!
    expect(customerCol.pgType).toBe('text')
    expect(customerCol.expression).toContain('jsonb_typeof')
    expect(customerCol.expression).toContain("->>'id'")
  })

  it('skips _updated_at (kept as a legacy hardcoded timestamptz column, not generated)', () => {
    const schema = {
      type: 'object',
      properties: { _updated_at: { type: 'integer' } },
    }
    expect(jsonSchemaToColumns(schema).find((c) => c.name === '_updated_at')).toBeUndefined()
  })
})

describe('buildCreateTableWithSchema', () => {
  it('produces generic DDL without _account_id when no options', () => {
    const stmts = buildCreateTableWithSchema('mydata', 'repos', SAMPLE_JSON_SCHEMA)

    // CREATE TABLE
    expect(stmts[0]).toContain('CREATE TABLE "mydata"."repos"')
    expect(stmts[0]).toContain('"_raw_data" jsonb NOT NULL')
    expect(stmts[0]).not.toContain('"_account_id"')
    expect(stmts[0]).toContain("GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED")

    // Generated columns in CREATE TABLE
    expect(stmts[0]).toContain('"created" bigint GENERATED ALWAYS AS')
    expect(stmts[0]).toContain('"metadata" jsonb GENERATED ALWAYS AS')

    // Single batched ALTER TABLE with all ADD COLUMN IF NOT EXISTS clauses
    const alterStmts = stmts.filter((s) => s.includes('ADD COLUMN IF NOT EXISTS'))
    expect(alterStmts.length).toBe(1)
    expect(alterStmts[0]).toContain('ADD COLUMN IF NOT EXISTS "created"')
    expect(alterStmts[0]).toContain('ADD COLUMN IF NOT EXISTS "deleted"')
    expect(alterStmts[0]).toContain('ADD COLUMN IF NOT EXISTS "metadata"')
    expect(alterStmts[0]).toContain('ADD COLUMN IF NOT EXISTS "expires_at"')

    // No FK constraint
    expect(stmts.some((s) => s.includes('FOREIGN KEY'))).toBe(false)

    // No indexes by default (no system_columns with index: true)
    expect(stmts.some((s) => s.includes('CREATE INDEX'))).toBe(false)

    // _updated_at keeps its legacy timestamptz shape so existing
    // deployments don't need a column migration. upsertMany writes the
    // source-stamped value explicitly per row (DDR-009); the legacy
    // trigger is dropped, and no new trigger is created.
    expect(stmts[0]).toContain('"_updated_at" timestamptz NOT NULL DEFAULT now()')
    expect(stmts.some((s) => s.includes('DROP TRIGGER IF EXISTS handle_updated_at'))).toBe(true)
    expect(stmts.some((s) => s.includes('CREATE TRIGGER handle_updated_at'))).toBe(false)
    expect(stmts.some((s) => s.includes('set_updated_at()'))).toBe(false)
  })

  it('adds system columns and indexes when system_columns is provided', () => {
    const stmts = buildCreateTableWithSchema('stripe', 'customers', SAMPLE_JSON_SCHEMA, {
      system_columns: [{ name: '_account_id', type: 'text', index: true }],
    })

    // Column present in CREATE TABLE
    expect(stmts[0]).toContain('"_account_id" text')
    // _account_id should be nullable (no NOT NULL)
    expect(stmts[0]).not.toMatch(/"_account_id" text NOT NULL/)

    // Index created
    expect(stmts.some((s) => s.includes('CREATE INDEX') && s.includes('"_account_id"'))).toBe(true)
  })

  it('handles multiple system columns with mixed index settings', () => {
    const stmts = buildCreateTableWithSchema('mydata', 'repos', SAMPLE_JSON_SCHEMA, {
      system_columns: [
        { name: '_account_id', type: 'text', index: true },
        { name: '_tenant_id', type: 'uuid', index: false },
      ],
    })

    expect(stmts[0]).toContain('"_account_id" text')
    expect(stmts[0]).toContain('"_tenant_id" uuid')

    // Only _account_id gets an index
    expect(stmts.some((s) => s.includes('CREATE INDEX') && s.includes('"_account_id"'))).toBe(true)
    expect(stmts.some((s) => s.includes('CREATE INDEX') && s.includes('"_tenant_id"'))).toBe(false)
  })

  it('handles expandable reference columns', () => {
    const stmts = buildCreateTableWithSchema('mydata', 'charges', EXPANDABLE_REF_SCHEMA)
    expect(stmts[0]).toContain('"customer" text GENERATED ALWAYS AS (CASE')
    expect(stmts[0]).toContain("WHEN jsonb_typeof(_raw_data->'customer') = 'object'")
  })

  it('generates composite primary key with _account_id when primary_key option is set', () => {
    const stmts = buildCreateTableWithSchema('stripe', 'customers', SAMPLE_JSON_SCHEMA, {
      primary_key: [['id'], ['_account_id']],
    })

    // Both PK columns present as generated columns.
    // Since SAMPLE_JSON_SCHEMA has no enum for _account_id, it defaults to text.
    expect(stmts[0]).toContain(`"id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED`)
    expect(stmts[0]).toContain(`"_account_id" text GENERATED ALWAYS AS`)

    // Composite PRIMARY KEY
    expect(stmts[0]).toContain('PRIMARY KEY ("id", "_account_id")')

    // _account_id should NOT appear as a regular generated column from json_schema
    const alterStmts = stmts.filter((s) => s.includes('ADD COLUMN IF NOT EXISTS'))
    expect(alterStmts.every((s) => !s.includes('"_account_id"'))).toBe(true)
  })

  it('produces stable output across repeated calls', () => {
    const first = buildCreateTableWithSchema('mydata', 'customers', SAMPLE_JSON_SCHEMA)
    const second = buildCreateTableWithSchema('mydata', 'customers', SAMPLE_JSON_SCHEMA)
    expect(second).toEqual(first)
  })

  it('emits a single _updated_at column even when declared in json_schema.properties', () => {
    // DDR-009: source declares `_updated_at: {type: 'integer'}` (unix seconds)
    // on the wire. The destination keeps the legacy hardcoded
    // `timestamptz NOT NULL DEFAULT now()` shape for backward compat;
    // jsonSchemaToColumns must skip it to avoid a duplicate generated column.
    const schemaWithUpdatedAt: Record<string, unknown> = {
      type: 'object',
      properties: {
        ...(SAMPLE_JSON_SCHEMA.properties as Record<string, unknown>),
        _updated_at: { type: 'integer' },
      },
    }
    const stmts = buildCreateTableWithSchema('stripe', 'customers', schemaWithUpdatedAt)

    expect(stmts[0]).toContain('"_updated_at" timestamptz NOT NULL DEFAULT now()')
    expect(stmts[0]).not.toContain('"_updated_at" bigint')
    expect(stmts[0]).not.toContain('"_updated_at" timestamptz GENERATED ALWAYS')

    const alter = stmts.find((s) => s.includes('ADD COLUMN IF NOT EXISTS')) ?? ''
    expect(alter).not.toContain('"_updated_at"')

    const occurrences = (stmts[0].match(/"_updated_at"/g) || []).length
    expect(occurrences).toBe(1)
  })
})

describe('buildCreateTableDDL', () => {
  it('buildCreateTableDDL emits CHECK with IN list for any column with enum in JSON Schema', () => {
    const ddl = buildCreateTableDDL(
      'stripe',
      'charges',
      {
        properties: {
          id: { type: 'string' },
          _account_id: { type: 'string', enum: ['acct_a', 'acct_b'] },
        },
      },
      { primary_key: [['id'], ['_account_id']] }
    )

    expect(ddl).toContain('"_account_id" text GENERATED ALWAYS AS')
    expect(ddl).toContain(
      `CHECK ((_raw_data->>'_account_id') IS NOT NULL AND (_raw_data->>'_account_id') IN ('acct_a', 'acct_b'))`
    )
    expect(ddl).not.toContain('NOT VALID')
    expect(ddl).toContain('EXCEPTION WHEN duplicate_object')
    expect(ddl.indexOf('DO $check$')).toBeGreaterThan(ddl.indexOf('$ddl$;'))
  })

  it('buildCreateTableDDL emits CHECK for non-account enum columns too', () => {
    const ddl = buildCreateTableDDL('stripe', 'events', {
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused', 'cancelled'] },
      },
    })

    expect(ddl).toContain(
      `CHECK ((_raw_data->>'status') IS NOT NULL AND (_raw_data->>'status') IN ('active', 'paused', 'cancelled'))`
    )
    expect(ddl).not.toContain('NOT VALID')
  })

  it('buildCreateTableDDL skips CHECK when no enum is present in JSON Schema', () => {
    const ddl = buildCreateTableDDL('stripe', 'charges', SAMPLE_JSON_SCHEMA, {
      primary_key: [['id'], ['_account_id']],
    })
    expect(ddl).toContain('"_account_id" text GENERATED ALWAYS AS')
    expect(ddl).not.toContain('DO $check$')
  })
  it('returns a single DO block containing all DDL', () => {
    const ddl = buildCreateTableDDL('mydata', 'repos', SAMPLE_JSON_SCHEMA)

    expect(ddl).toMatch(/^DO \$ddl\$/)
    expect(ddl).toMatch(/\$ddl\$;$/)

    expect(ddl).toContain('CREATE TABLE "mydata"."repos"')
    expect(ddl).toContain('"_raw_data" jsonb NOT NULL')
    expect(ddl).toContain("GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED")
    expect(ddl).toContain('"created" bigint GENERATED ALWAYS AS')

    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "created"')
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "deleted"')
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "metadata"')
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "expires_at"')

    expect(ddl).toContain('"_updated_at" timestamptz NOT NULL DEFAULT now()')
    expect(ddl).toContain('DROP TRIGGER IF EXISTS handle_updated_at')
    expect(ddl).not.toContain('CREATE TRIGGER handle_updated_at')
  })

  it('wraps every DDL statement in exception handlers', () => {
    const ddl = buildCreateTableDDL('stripe', 'customers', SAMPLE_JSON_SCHEMA, {
      system_columns: [{ name: '_account_id', type: 'text', index: true }],
    })

    expect(ddl).toContain('EXCEPTION WHEN duplicate_table')
    expect(ddl).toContain('CREATE INDEX')
    expect(ddl).toContain('"_account_id"')

    // Exception handlers: CREATE TABLE, ALTER, CREATE INDEX in $ddl$ (3).
    // No CHECK constraint since SAMPLE_JSON_SCHEMA has no enum on _account_id.
    const exceptionCount = (ddl.match(/EXCEPTION WHEN/g) || []).length
    expect(exceptionCount).toBe(3)
  })

  it('contains every SQL statement from buildCreateTableWithSchema', () => {
    const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

    const schemas = [SAMPLE_JSON_SCHEMA, EXPANDABLE_REF_SCHEMA]
    const optionSets = [
      {},
      { system_columns: [{ name: '_account_id', type: 'text' as const, index: true }] },
      {
        system_columns: [
          { name: '_account_id', type: 'text' as const, index: true },
          { name: '_tenant_id', type: 'uuid' as const, index: false },
        ],
      },
    ]

    for (const schema of schemas) {
      for (const opts of optionSets) {
        const stmts = buildCreateTableWithSchema('s', 't', schema, opts)
        const ddlCollapsed = collapse(buildCreateTableDDL('s', 't', schema, opts))

        for (const stmt of stmts) {
          const stmtCollapsed = collapse(stmt.replace(/;\s*$/, ''))
          expect(ddlCollapsed).toContain(stmtCollapsed)
        }
      }
    }
  })

  it('produces stable output across repeated calls', () => {
    const first = buildCreateTableDDL('mydata', 'customers', SAMPLE_JSON_SCHEMA)
    const second = buildCreateTableDDL('mydata', 'customers', SAMPLE_JSON_SCHEMA)
    expect(second).toEqual(first)
  })
})
