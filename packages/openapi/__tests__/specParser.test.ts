import { describe, expect, it } from 'vitest'
import { SpecParser } from '../specParser'
import { minimalStripeOpenApiSpec } from './fixtures/minimalSpec'
import type { OpenApiSpec } from '../../types'

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

  describe('discoverListableResourceIds', () => {
    it('discovers resource ids from list endpoints in paths', () => {
      const parser = new SpecParser()
      const ids = parser.discoverListableResourceIds(minimalStripeOpenApiSpec)

      expect(ids).toEqual(
        new Set([
          'customer',
          'plan',
          'price',
          'product',
          'subscription_item',
          'checkout.session',
          'radar.early_fraud_warning',
          'entitlements.active_entitlement',
          'entitlements.feature',
          'v2.core.account',
          'v2.core.event_destination',
        ])
      )
    })

    it('optionally includes nested list endpoints', () => {
      const parser = new SpecParser()
      const spec: OpenApiSpec = {
        ...minimalStripeOpenApiSpec,
        paths: {
          ...minimalStripeOpenApiSpec.paths,
          '/v1/accounts/{account}/persons': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object' as const,
                        properties: {
                          object: {
                            type: 'string' as const,
                            enum: ['list'],
                          },
                          data: {
                            type: 'array' as const,
                            items: {
                              $ref: '#/components/schemas/person',
                            },
                          },
                          has_more: {
                            type: 'boolean' as const,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          ...minimalStripeOpenApiSpec.components,
          schemas: {
            ...minimalStripeOpenApiSpec.components.schemas,
            person: {
              'x-resourceId': 'person',
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
          },
        },
      }

      const ids = parser.discoverListableResourceIds(spec, { includeNested: true })
      expect(ids).toContain('person')
    })

    it('returns empty set when spec has no paths', () => {
      const parser = new SpecParser()
      const specWithoutPaths: OpenApiSpec = {
        ...minimalStripeOpenApiSpec,
        paths: undefined,
      }
      expect(parser.discoverListableResourceIds(specWithoutPaths)).toEqual(new Set())
    })

    it('ignores non-list GET endpoints', () => {
      const parser = new SpecParser()
      const spec: OpenApiSpec = {
        openapi: '3.0.0',
        paths: {
          '/v1/customers/{customer}': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            customer: {
              'x-resourceId': 'customer',
              type: 'object',
              properties: { id: { type: 'string' } },
            },
          },
        },
      }
      expect(parser.discoverListableResourceIds(spec)).toEqual(new Set())
    })
  })

  describe('auto-discovery via paths (no allowedTables)', () => {
    it('creates tables only for resources with list endpoints', () => {
      const parser = new SpecParser()
      const parsed = parser.parse(minimalStripeOpenApiSpec)

      const tableNames = parsed.tables.map((t) => t.tableName)
      expect(tableNames).toEqual([
        'active_entitlements',
        'checkout_sessions',
        'customers',
        'early_fraud_warnings',
        'features',
        'plans',
        'prices',
        'products',
        'subscription_items',
        'v2_core_accounts',
        'v2_core_event_destinations',
      ])
    })

    it('includes nested listables when they appear in the OpenAPI paths', () => {
      const parser = new SpecParser()
      const spec: OpenApiSpec = {
        ...minimalStripeOpenApiSpec,
        paths: {
          ...minimalStripeOpenApiSpec.paths,
          '/v1/accounts/{account}/persons': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object' as const,
                        properties: {
                          object: {
                            type: 'string' as const,
                            enum: ['list'],
                          },
                          data: {
                            type: 'array' as const,
                            items: {
                              $ref: '#/components/schemas/person',
                            },
                          },
                          has_more: {
                            type: 'boolean' as const,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          ...minimalStripeOpenApiSpec.components,
          schemas: {
            ...minimalStripeOpenApiSpec.components.schemas,
            person: {
              'x-resourceId': 'person',
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
          },
        },
      }

      const parsed = parser.parse(spec)
      const tableNames = parsed.tables.map((table) => table.tableName)
      expect(tableNames).toContain('persons')
    })

    it('excludes schemas that have no list endpoint', () => {
      const parser = new SpecParser()
      const specWithLimitedPaths: OpenApiSpec = {
        ...minimalStripeOpenApiSpec,
        paths: {
          '/v1/customers': minimalStripeOpenApiSpec.paths!['/v1/customers'],
          '/v1/products': minimalStripeOpenApiSpec.paths!['/v1/products'],
        },
      }
      const parsed = parser.parse(specWithLimitedPaths)

      const tableNames = parsed.tables.map((t) => t.tableName)
      expect(tableNames).toEqual(['customers', 'products'])
      expect(tableNames).not.toContain('plans')
      expect(tableNames).not.toContain('subscription_items')
    })

    it('resolves table name aliases from x-resourceId during discovery', () => {
      const parser = new SpecParser()
      const parsed = parser.parse(minimalStripeOpenApiSpec)

      const earlyFraud = parsed.tables.find((t) => t.tableName === 'early_fraud_warnings')
      expect(earlyFraud).toBeDefined()
      expect(earlyFraud?.resourceId).toBe('radar.early_fraud_warning')

      const checkout = parsed.tables.find((t) => t.tableName === 'checkout_sessions')
      expect(checkout).toBeDefined()
      expect(checkout?.resourceId).toBe('checkout.session')
    })
  })
})
