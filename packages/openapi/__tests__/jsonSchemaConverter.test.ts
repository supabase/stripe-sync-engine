import { describe, expect, it } from 'vitest'
import { parsedTableToJsonSchema } from '../jsonSchemaConverter'
import type { ParsedResourceTable } from '../types'

describe('parsedTableToJsonSchema', () => {
  it('maps scalar types and marks non-nullable columns as required', () => {
    const table: ParsedResourceTable = {
      tableName: 'customer',
      resourceId: 'customer',
      sourceSchemaName: 'customer',
      columns: [
        { name: 'created', type: 'bigint', nullable: false },
        { name: 'object', type: 'text', nullable: false },
        { name: 'metadata', type: 'json', nullable: true },
        { name: 'expires_at', type: 'timestamptz', nullable: true },
        { name: 'balance', type: 'numeric', nullable: true },
        { name: 'deleted', type: 'boolean', nullable: true },
        { name: 'email', type: 'text', nullable: true },
      ],
    }

    const schema = parsedTableToJsonSchema(table)

    expect(schema.type).toBe('object')

    const props = schema.properties as Record<string, Record<string, unknown>>
    expect(props.id).toEqual({ type: 'string' })
    expect(props.created).toEqual({ type: 'integer' })
    expect(props.object).toEqual({ type: 'string' })

    expect(props.metadata).toEqual({ oneOf: [{ type: 'object' }, { type: 'null' }] })
    expect(props.expires_at).toEqual({
      oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    })
    expect(props.balance).toEqual({ oneOf: [{ type: 'number' }, { type: 'null' }] })
    expect(props.deleted).toEqual({ oneOf: [{ type: 'boolean' }, { type: 'null' }] })
    expect(props.email).toEqual({ oneOf: [{ type: 'string' }, { type: 'null' }] })

    const required = schema.required as string[]
    expect(required).toEqual(['id', 'created', 'object'])
  })

  it('annotates expandable reference columns with x-expandable-reference', () => {
    const table: ParsedResourceTable = {
      tableName: 'charge',
      resourceId: 'charge',
      sourceSchemaName: 'charge',
      columns: [
        { name: 'customer', type: 'json', nullable: true, expandableReference: true },
        { name: 'invoice', type: 'json', nullable: false, expandableReference: true },
      ],
    }

    const schema = parsedTableToJsonSchema(table)
    const props = schema.properties as Record<string, Record<string, unknown>>

    expect(props.customer).toEqual({
      oneOf: [{ type: 'object' }, { type: 'null' }],
      'x-expandable-reference': true,
    })
    expect(props.invoice).toEqual({
      type: 'object',
      'x-expandable-reference': true,
    })
  })

  it('always includes id as a required string', () => {
    const table: ParsedResourceTable = {
      tableName: 'product',
      resourceId: 'product',
      sourceSchemaName: 'product',
      columns: [],
    }

    const schema = parsedTableToJsonSchema(table)
    const props = schema.properties as Record<string, Record<string, unknown>>
    expect(props.id).toEqual({ type: 'string' })
    expect(schema.required as string[]).toEqual(['id'])
  })
})
