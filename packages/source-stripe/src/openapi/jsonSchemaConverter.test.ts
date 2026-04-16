import { describe, expect, it } from 'vitest'
import { parsedTableToJsonSchema } from './jsonSchemaConverter.js'
import type { ParsedResourceTable } from './types.js'

describe('parsedTableToJsonSchema', () => {
  it('converts a parsed table to JSON Schema with correct type mappings', () => {
    const table: ParsedResourceTable = {
      tableName: 'customers',
      resourceId: 'customer',
      sourceSchemaName: 'customer',
      columns: [
        { name: 'created', type: 'bigint', nullable: false },
        { name: 'deleted', type: 'boolean', nullable: true },
        { name: 'metadata', type: 'json', nullable: true },
        { name: 'expires_at', type: 'timestamptz', nullable: true },
        { name: 'balance', type: 'numeric', nullable: true },
        { name: 'email', type: 'text', nullable: true },
      ],
    }

    const schema = parsedTableToJsonSchema(table)

    expect(schema.type).toBe('object')
    expect(schema['x-source-schema']).toBe('customer')

    const props = schema.properties as Record<string, Record<string, unknown>>
    expect(props.id).toEqual({ type: 'string' })
    expect(props.created).toEqual({ type: 'integer' })
    expect(props.deleted).toEqual({ type: 'boolean' })
    expect(props.metadata).toEqual({ type: 'object' })
    expect(props.expires_at).toEqual({ type: 'string', format: 'date-time' })
    expect(props.balance).toEqual({ type: 'number' })
    expect(props.email).toEqual({ type: 'string' })

    // Non-nullable columns should be required, nullable ones should not
    const required = schema.required as string[]
    expect(required).toContain('id')
    expect(required).toContain('created')
    expect(required).not.toContain('deleted')
    expect(required).not.toContain('metadata')
    expect(required).not.toContain('expires_at')
  })

  it('marks expandable references with x-expandable-reference', () => {
    const table: ParsedResourceTable = {
      tableName: 'charges',
      resourceId: 'charge',
      sourceSchemaName: 'charge',
      columns: [{ name: 'customer', type: 'json', nullable: true, expandableReference: true }],
    }

    const schema = parsedTableToJsonSchema(table)
    const props = schema.properties as Record<string, Record<string, unknown>>
    expect(props.customer['x-expandable-reference']).toBe(true)
    expect(props.customer.type).toBe('object')
  })

  it('always includes id in properties and required', () => {
    const table: ParsedResourceTable = {
      tableName: 'products',
      resourceId: 'product',
      sourceSchemaName: 'product',
      columns: [],
    }

    const schema = parsedTableToJsonSchema(table)
    const props = schema.properties as Record<string, Record<string, unknown>>
    expect(props.id).toEqual({ type: 'string' })
    expect(schema.required as string[]).toContain('id')
  })
})
