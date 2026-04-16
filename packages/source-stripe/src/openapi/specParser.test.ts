import { describe, expect, it } from 'vitest'
import { SpecParser } from './specParser.js'
import { minimalStripeOpenApiSpec } from './fixtures/minimalSpec.js'

describe('SpecParser', () => {
  it('parses aliased resources into deterministic tables and column types', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: ['checkout_sessions', 'customers', 'early_fraud_warnings'],
    })

    expect(parsed.tables.map((table) => table.tableName)).toEqual([
      'checkout_sessions',
      'customers',
      'early_fraud_warnings',
    ])

    const customers = parsed.tables.find((table) => table.tableName === 'customers')
    expect(customers?.columns).toEqual([
      { name: 'created', type: 'bigint', nullable: false },
      { name: 'deleted', type: 'boolean', nullable: false },
      { name: 'object', type: 'text', nullable: false },
    ])

    const checkoutSessions = parsed.tables.find((table) => table.tableName === 'checkout_sessions')
    expect(checkoutSessions?.columns).toContainEqual({
      name: 'amount_total',
      type: 'bigint',
      nullable: false,
    })
  })

  it('injects compatibility columns for runtime-critical tables', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: { schemas: {} },
      },
      { allowedTables: ['active_entitlements', 'subscription_items'] }
    )

    const activeEntitlements = parsed.tables.find(
      (table) => table.tableName === 'active_entitlements'
    )
    expect(activeEntitlements?.columns).toContainEqual({
      name: 'customer',
      type: 'text',
      nullable: true,
    })

    const subscriptionItems = parsed.tables.find(
      (table) => table.tableName === 'subscription_items'
    )
    expect(subscriptionItems?.columns).toContainEqual({
      name: 'deleted',
      type: 'boolean',
      nullable: true,
    })
    expect(subscriptionItems?.columns).toContainEqual({
      name: 'subscription',
      type: 'text',
      nullable: true,
    })
  })

  it('is deterministic regardless of schema key order', () => {
    const parser = new SpecParser()
    const normal = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: ['customers', 'plans', 'prices'],
    })

    const reversedSchemas = Object.fromEntries(
      Object.entries(minimalStripeOpenApiSpec.components?.schemas ?? {}).reverse()
    )
    const reversed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: reversedSchemas,
        },
      },
      { allowedTables: ['customers', 'plans', 'prices'] }
    )

    expect(reversed).toEqual(normal)
  })

  it('marks expandable references from x-expansionResources metadata', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: {
            charge: {
              'x-resourceId': 'charge',
              type: 'object',
              properties: {
                id: { type: 'string' },
                customer: {
                  anyOf: [{ type: 'string' }, { $ref: '#/components/schemas/customer' }],
                  'x-expansionResources': {
                    oneOf: [{ $ref: '#/components/schemas/customer' }],
                  },
                },
              },
            },
            customer: {
              'x-resourceId': 'customer',
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
          },
        },
      },
      { allowedTables: ['charges'] }
    )

    const charges = parsed.tables.find((table) => table.tableName === 'charges')
    expect(charges?.columns).toContainEqual({
      name: 'customer',
      type: 'json',
      nullable: false,
      expandableReference: true,
    })
  })
})
