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
  it('produces CREATE TABLE + ALTER TABLE ADD COLUMN + FK + index + trigger', () => {
    const stmts = buildCreateTableWithSchema('stripe', 'customers', SAMPLE_JSON_SCHEMA)

    // CREATE TABLE
    expect(stmts[0]).toContain('CREATE TABLE "stripe"."customers"')
    expect(stmts[0]).toContain('"_raw_data" jsonb NOT NULL')
    expect(stmts[0]).toContain('"_account_id" text NOT NULL')
    expect(stmts[0]).toContain("GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED")

    // Generated columns in CREATE TABLE
    expect(stmts[0]).toContain('"created" bigint GENERATED ALWAYS AS')
    expect(stmts[0]).toContain('"metadata" jsonb GENERATED ALWAYS AS')

    // ALTER TABLE ADD COLUMN IF NOT EXISTS for each column
    const alterStmts = stmts.filter((s) => s.includes('ADD COLUMN IF NOT EXISTS'))
    expect(alterStmts.length).toBe(4) // created, deleted, metadata, expires_at

    // FK constraint
    expect(stmts.some((s) => s.includes('FOREIGN KEY ("_account_id")'))).toBe(true)
    expect(stmts.some((s) => s.includes('REFERENCES "stripe"."accounts"'))).toBe(true)

    // Index
    expect(stmts.some((s) => s.includes('CREATE INDEX'))).toBe(true)

    // Trigger
    expect(stmts.some((s) => s.includes('handle_updated_at'))).toBe(true)
    expect(stmts.some((s) => s.includes('set_updated_at()'))).toBe(true)
  })

  it('uses accountSchema for FK when provided', () => {
    const stmts = buildCreateTableWithSchema('stripe_data', 'customers', SAMPLE_JSON_SCHEMA, {
      accountSchema: 'stripe_sync',
    })
    expect(stmts[0]).toContain('CREATE TABLE "stripe_data"."customers"')
    expect(stmts.some((s) => s.includes('REFERENCES "stripe_sync"."accounts"'))).toBe(true)
  })

  it('handles expandable reference columns', () => {
    const stmts = buildCreateTableWithSchema('stripe', 'charges', EXPANDABLE_REF_SCHEMA)
    expect(stmts[0]).toContain('"customer" text GENERATED ALWAYS AS (CASE')
    expect(stmts[0]).toContain("WHEN jsonb_typeof(_raw_data->'customer') = 'object'")
  })

  it('produces stable output across repeated calls', () => {
    const first = buildCreateTableWithSchema('stripe', 'customers', SAMPLE_JSON_SCHEMA)
    const second = buildCreateTableWithSchema('stripe', 'customers', SAMPLE_JSON_SCHEMA)
    expect(second).toEqual(first)
  })
})
