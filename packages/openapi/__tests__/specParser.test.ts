import { describe, expect, it } from 'vitest'
import { SpecParser } from '../specParser'
import { minimalStripeOpenApiSpec } from './fixtures/minimalSpec'
import type { OpenApiSpec } from '../../types'

describe('SpecParser', () => {
  it('parses aliased resources into deterministic tables and column types', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: ['checkout_session', 'customer', 'early_fraud_warning'],
    })

    expect(parsed.tables.map((table) => table.tableName)).toEqual([
      'checkout_session',
      'customer',
      'early_fraud_warning',
    ])

    const customers = parsed.tables.find((table) => table.tableName === 'customer')
    expect(customers?.columns).toEqual([
      { name: 'created', type: 'bigint', nullable: false },
      { name: 'object', type: 'text', nullable: false },
    ])
    expect(customers?.columns).not.toContainEqual(expect.objectContaining({ name: 'deleted' }))

    const checkoutSessions = parsed.tables.find((table) => table.tableName === 'checkout_session')
    expect(checkoutSessions?.columns).toContainEqual({
      name: 'amount_total',
      type: 'bigint',
      nullable: false,
    })
  })

  it('is deterministic regardless of schema key order', () => {
    const parser = new SpecParser()
    const normal = parser.parse(minimalStripeOpenApiSpec, {
      allowedTables: ['customer', 'plan', 'price'],
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
      { allowedTables: ['customer', 'plan', 'price'] }
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
      { allowedTables: ['charge'] }
    )

    const charges = parsed.tables.find((table) => table.tableName === 'charge')
    expect(charges?.columns).toContainEqual({
      name: 'customer',
      type: 'json',
      nullable: false,
      expandableReference: true,
    })
  })

  it('excludes list envelope properties from parent tables', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: {
            subscription: {
              'x-resourceId': 'subscription',
              type: 'object',
              properties: {
                id: { type: 'string' },
                items: {
                  type: 'object',
                  properties: {
                    object: { enum: ['list'] },
                    data: { type: 'array', items: { type: 'string' } },
                    has_more: { type: 'boolean' },
                    url: { type: 'string' },
                  },
                },
                latest_invoice: { type: 'object', properties: { id: { type: 'string' } } },
              },
            },
          },
        },
      },
      { allowedTables: ['subscription'] }
    )

    const subscription = parsed.tables.find((table) => table.tableName === 'subscription')
    expect(subscription?.columns).toContainEqual({
      name: 'latest_invoice',
      type: 'json',
      nullable: false,
    })
    expect(subscription?.columns.map((c) => c.name)).not.toContain('items')
  })

  it('excludes list envelope properties when they are references', () => {
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
                refunds: { $ref: '#/components/schemas/refund_list' },
                metadata: { type: 'object' },
              },
            },
            refund_list: {
              type: 'object',
              properties: {
                object: { enum: ['list'] },
                data: { type: 'array', items: { type: 'string' } },
                has_more: { type: 'boolean' },
              },
            },
          },
        },
      },
      { allowedTables: ['charge'] }
    )

    const charge = parsed.tables.find((table) => table.tableName === 'charge')
    expect(charge?.columns).toContainEqual({ name: 'metadata', type: 'json', nullable: false })
    expect(charge?.columns.map((c) => c.name)).not.toContain('refunds')
  })

  it('excludes v2 list envelope properties', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: {
            v2_event_destination: {
              'x-resourceId': 'v2.core.event_destination',
              type: 'object',
              properties: {
                id: { type: 'string' },
                deliveries: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { type: 'string' } },
                    next_page_url: { type: 'string' },
                  },
                },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      { allowedTables: ['v2_core_event_destination'] }
    )

    const eventDest = parsed.tables.find((table) => table.tableName === 'v2_core_event_destination')
    expect(eventDest?.columns).toContainEqual({
      name: 'description',
      type: 'text',
      nullable: false,
    })
    expect(eventDest?.columns.map((c) => c.name)).not.toContain('deliveries')
  })

  it('excludes list envelope properties in oneOf', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: {
            product: {
              'x-resourceId': 'product',
              type: 'object',
              properties: {
                id: { type: 'string' },
                discounts: {
                  oneOf: [
                    {
                      type: 'object',
                      properties: {
                        object: { enum: ['list'] },
                        data: { type: 'array', items: { type: 'string' } },
                      },
                    },
                  ],
                },
                name: { type: 'string' },
              },
            },
          },
        },
      },
      { allowedTables: ['product'] }
    )

    const product = parsed.tables.find((table) => table.tableName === 'product')
    expect(product?.columns).toContainEqual({ name: 'name', type: 'text', nullable: false })
    expect(product?.columns.map((c) => c.name)).not.toContain('discounts')
  })

  it('keeps objects with data arrays that are not list envelopes', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: {
            product: {
              'x-resourceId': 'product',
              type: 'object',
              properties: {
                id: { type: 'string' },
                attributes: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { type: 'string' } },
                    label: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      { allowedTables: ['product'] }
    )

    const product = parsed.tables.find((table) => table.tableName === 'product')
    expect(product?.columns).toContainEqual({ name: 'attributes', type: 'json', nullable: false })
  })

  it('excludes list envelope properties in anyOf', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: {
            product: {
              'x-resourceId': 'product',
              type: 'object',
              properties: {
                id: { type: 'string' },
                discounts: {
                  anyOf: [
                    {
                      type: 'object',
                      properties: {
                        object: { enum: ['list'] },
                        data: { type: 'array', items: { type: 'string' } },
                      },
                    },
                  ],
                },
                name: { type: 'string' },
              },
            },
          },
        },
      },
      { allowedTables: ['product'] }
    )

    const product = parsed.tables.find((table) => table.tableName === 'product')
    expect(product?.columns).toContainEqual({ name: 'name', type: 'text', nullable: false })
    expect(product?.columns.map((c) => c.name)).not.toContain('discounts')
  })

  it('keeps properties when only some composition branches are list envelopes', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: {
            product: {
              'x-resourceId': 'product',
              type: 'object',
              properties: {
                id: { type: 'string' },
                discounts: {
                  oneOf: [
                    {
                      type: 'object',
                      properties: {
                        object: { enum: ['list'] },
                        data: { type: 'array', items: { type: 'string' } },
                      },
                    },
                    { type: 'string' },
                  ],
                },
                name: { type: 'string' },
              },
            },
          },
        },
      },
      { allowedTables: ['product'] }
    )

    const product = parsed.tables.find((table) => table.tableName === 'product')
    expect(product?.columns.map((c) => c.name)).toContain('discounts')
  })

  it('excludes list envelope via $ref inside composition', () => {
    const parser = new SpecParser()
    const parsed = parser.parse(
      {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: {
            product: {
              'x-resourceId': 'product',
              type: 'object',
              properties: {
                id: { type: 'string' },
                discounts: {
                  oneOf: [{ $ref: '#/components/schemas/discount_list' }],
                },
                name: { type: 'string' },
              },
            },
            discount_list: {
              type: 'object',
              properties: {
                object: { enum: ['list'] },
                data: { type: 'array', items: { type: 'string' } },
                has_more: { type: 'boolean' },
              },
            },
          },
        },
      },
      { allowedTables: ['product'] }
    )

    const product = parsed.tables.find((table) => table.tableName === 'product')
    expect(product?.columns).toContainEqual({ name: 'name', type: 'text', nullable: false })
    expect(product?.columns.map((c) => c.name)).not.toContain('discounts')
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
      expect(ids).not.toContain('recipient')
      expect(ids).not.toContain('exchange_rate')
      expect(ids).not.toContain('deprecated_widget')
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

      const ids = parser.discoverListableResourceIds(spec, {
        includeNested: true,
      })
      expect(ids).toContain('person')
    })

    it('excludes paths present in the generated global deprecated set', () => {
      const parser = new SpecParser()
      const ids = parser.discoverListableResourceIds(minimalStripeOpenApiSpec)
      expect(ids).not.toContain('recipient')
      expect(ids).toContain('customer')
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

  describe('discoverWebhookUpdatableResourceIds', () => {
    it('discovers resource ids that have create/update/delete webhook events', () => {
      const parser = new SpecParser()
      const ids = parser.discoverWebhookUpdatableResourceIds(minimalStripeOpenApiSpec)

      expect(ids).toContain('customer')
      expect(ids).toContain('plan')
      expect(ids).toContain('price')
      expect(ids).toContain('product')
      expect(ids).toContain('subscription_item')
      expect(ids).toContain('checkout.session')
      expect(ids).toContain('radar.early_fraud_warning')
      expect(ids).toContain('entitlements.active_entitlement')
      expect(ids).toContain('entitlements.feature')
      expect(ids).toContain('v2.core.account')
      expect(ids).toContain('v2.core.event_destination')
    })

    it('excludes resources that have no create/update/delete webhook events', () => {
      const parser = new SpecParser()
      const ids = parser.discoverWebhookUpdatableResourceIds(minimalStripeOpenApiSpec)

      // recipient, exchange_rate, deprecated_widget have no webhook event schemas
      expect(ids).not.toContain('recipient')
      expect(ids).not.toContain('exchange_rate')
      expect(ids).not.toContain('deprecated_widget')
    })

    it('ignores webhook events that are not create/update/delete', () => {
      const parser = new SpecParser()
      const spec: OpenApiSpec = {
        ...minimalStripeOpenApiSpec,
        components: {
          schemas: {
            ...minimalStripeOpenApiSpec.components?.schemas,
            customer_no_crud_events: {
              'x-resourceId': 'customer_no_crud_events',
              type: 'object',
              properties: { id: { type: 'string' } },
            },
            'customer_no_crud_events.authorized': {
              'x-stripeEvent': { type: 'customer_no_crud_events.authorized' },
              type: 'object',
              properties: {
                object: { $ref: '#/components/schemas/customer_no_crud_events' },
              },
            },
          },
        },
      }
      const ids = parser.discoverWebhookUpdatableResourceIds(spec)
      expect(ids).not.toContain('customer_no_crud_events')
    })

    it('returns empty set when spec has no schemas', () => {
      const parser = new SpecParser()
      const spec: OpenApiSpec = {
        ...minimalStripeOpenApiSpec,
        components: { schemas: {} },
      }
      expect(parser.discoverWebhookUpdatableResourceIds(spec)).toEqual(new Set())
    })
  })

  describe('auto-discovery via paths (no allowedTables)', () => {
    it('creates tables only for resources with list endpoints', () => {
      const parser = new SpecParser()
      const parsed = parser.parse(minimalStripeOpenApiSpec)

      const tableNames = parsed.tables.map((t) => t.tableName)
      expect(tableNames).toEqual([
        'active_entitlement',
        'checkout_session',
        'customer',
        'early_fraud_warning',
        'feature',
        'plan',
        'price',
        'product',
        'subscription_item',
        'v2_core_account',
        'v2_core_event_destination',
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
            'person.created': {
              'x-stripeEvent': { type: 'person.created' },
              type: 'object' as const,
              properties: { object: { $ref: '#/components/schemas/person' } },
            },
          },
        },
      }

      const parsed = parser.parse(spec)
      const tableNames = parsed.tables.map((table) => table.tableName)
      expect(tableNames).toContain('person')
    })

    it('excludes generated global deprecated paths from auto-discovered tables', () => {
      const parser = new SpecParser()
      const parsed = parser.parse(minimalStripeOpenApiSpec)
      const tableNames = parsed.tables.map((t) => t.tableName)
      expect(tableNames).not.toContain('recipient')
      expect(tableNames).toContain('customer')
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
      expect(tableNames).toEqual(['customer', 'product'])
      expect(tableNames).not.toContain('plan')
      expect(tableNames).not.toContain('subscription_item')
    })

    it('excludes resources that have a list endpoint but no webhook events', () => {
      const parser = new SpecParser()
      // Build a spec where 'product' has a list endpoint but its webhook events are removed
      const schemasWithoutProductEvents = Object.fromEntries(
        Object.entries(minimalStripeOpenApiSpec.components?.schemas ?? {}).filter(
          ([k]) => !k.startsWith('product.')
        )
      )
      const spec: OpenApiSpec = {
        ...minimalStripeOpenApiSpec,
        components: { schemas: schemasWithoutProductEvents },
      }
      const parsed = parser.parse(spec)
      const tableNames = parsed.tables.map((t) => t.tableName)
      expect(tableNames).not.toContain('product')
      expect(tableNames).toContain('customer')
    })

    it('resolves table name aliases from x-resourceId during discovery', () => {
      const parser = new SpecParser()
      const parsed = parser.parse(minimalStripeOpenApiSpec)

      const earlyFraud = parsed.tables.find((t) => t.tableName === 'early_fraud_warning')
      expect(earlyFraud).toBeDefined()
      expect(earlyFraud?.resourceId).toBe('radar.early_fraud_warning')

      const checkout = parsed.tables.find((t) => t.tableName === 'checkout_session')
      expect(checkout).toBeDefined()
      expect(checkout?.resourceId).toBe('checkout.session')
    })
  })
})

describe('SpecParser.discoverSyncableTables', () => {
  const parser = new SpecParser()

  it('returns the intersection of listable and webhook-updatable resources, resolved to table names', () => {
    const tables = parser.discoverSyncableTables(minimalStripeOpenApiSpec)

    expect(tables).toContain('customer')
    expect(tables).toContain('product')
    expect(tables).toContain('plan')
    expect(tables).toContain('checkout_session')
    expect(tables).toContain('early_fraud_warning')
  })

  it('excludes resources that are listable but have no webhook events', () => {
    const tables = parser.discoverSyncableTables(minimalStripeOpenApiSpec)

    expect(tables).not.toContain('exchange_rate')
    expect(tables).not.toContain('recipient')
  })

  it('honors the excluded option', () => {
    const baseline = parser.discoverSyncableTables(minimalStripeOpenApiSpec)
    expect(baseline).toContain('customer')

    const filtered = parser.discoverSyncableTables(minimalStripeOpenApiSpec, {
      excluded: new Set(['customer']),
    })
    expect(filtered).not.toContain('customer')
    expect(filtered).toContain('product')
  })

  it('honors caller-provided aliases over the defaults', () => {
    const tables = parser.discoverSyncableTables(minimalStripeOpenApiSpec, {
      aliases: { customer: 'patron' },
    })
    expect(tables).toContain('patron')
    expect(tables).not.toContain('customer')
  })

  it('returns the same set that SpecParser.parse uses internally', () => {
    const parsed = parser.parse(minimalStripeOpenApiSpec)
    const parsedTables = new Set(parsed.tables.map((t) => t.tableName))
    const syncable = parser.discoverSyncableTables(minimalStripeOpenApiSpec)

    expect(syncable).toEqual(parsedTables)
  })

  it('returns empty set when spec has no paths', () => {
    const spec: OpenApiSpec = { ...minimalStripeOpenApiSpec, paths: {} }
    expect(parser.discoverSyncableTables(spec)).toEqual(new Set())
  })
})
