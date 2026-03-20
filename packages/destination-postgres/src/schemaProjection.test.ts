import { describe, expect, it } from 'vitest'
import { jsonSchemaToColumns, buildCreateTableWithSchema } from './schemaProjection'

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

    // ALTER TABLE ADD COLUMN IF NOT EXISTS for each column
    const alterStmts = stmts.filter((s) => s.includes('ADD COLUMN IF NOT EXISTS'))
    expect(alterStmts.length).toBe(4) // created, deleted, metadata, expires_at

    // No FK constraint
    expect(stmts.some((s) => s.includes('FOREIGN KEY'))).toBe(false)

    // No indexes by default (no system_columns with index: true)
    expect(stmts.some((s) => s.includes('CREATE INDEX'))).toBe(false)

    // Trigger
    expect(stmts.some((s) => s.includes('handle_updated_at'))).toBe(true)
    expect(stmts.some((s) => s.includes('set_updated_at()'))).toBe(true)
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

  it('produces stable output across repeated calls', () => {
    const first = buildCreateTableWithSchema('mydata', 'customers', SAMPLE_JSON_SCHEMA)
    const second = buildCreateTableWithSchema('mydata', 'customers', SAMPLE_JSON_SCHEMA)
    expect(second).toEqual(first)
  })
})
