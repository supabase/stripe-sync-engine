import { describe, expect, it } from 'vitest'
import { discoverListEndpoints } from '../listFnResolver'
import { minimalStripeOpenApiSpec } from './fixtures/minimalSpec'

describe('discoverListEndpoints', () => {
  it('maps table names to their API paths', () => {
    const endpoints = discoverListEndpoints(minimalStripeOpenApiSpec)

    expect(endpoints.get('customers')).toEqual({
      tableName: 'customers',
      resourceId: 'customer',
      apiPath: '/v1/customers',
      supportsCreatedFilter: true,
      supportsLimit: true,
    })
    expect(endpoints.get('checkout_sessions')).toEqual({
      tableName: 'checkout_sessions',
      resourceId: 'checkout.session',
      apiPath: '/v1/checkout/sessions',
      supportsCreatedFilter: true,
      supportsLimit: true,
    })
    expect(endpoints.get('early_fraud_warnings')).toEqual({
      tableName: 'early_fraud_warnings',
      resourceId: 'radar.early_fraud_warning',
      apiPath: '/v1/radar/early_fraud_warnings',
      supportsCreatedFilter: true,
      supportsLimit: true,
    })
  })

  it('discovers v2 list endpoints using next_page_url format', () => {
    const endpoints = discoverListEndpoints(minimalStripeOpenApiSpec)

    expect(endpoints.get('v2_core_accounts')).toEqual({
      tableName: 'v2_core_accounts',
      resourceId: 'v2.core.account',
      apiPath: '/v2/core/accounts',
      supportsCreatedFilter: false,
      supportsLimit: false,
    })
    expect(endpoints.get('v2_core_event_destinations')).toEqual({
      tableName: 'v2_core_event_destinations',
      resourceId: 'v2.core.event_destination',
      apiPath: '/v2/core/event_destinations',
      supportsCreatedFilter: false,
      supportsLimit: false,
    })
  })

  it('skips paths with path parameters', () => {
    const spec = {
      ...minimalStripeOpenApiSpec,
      paths: {
        ...minimalStripeOpenApiSpec.paths,
        '/v1/customers/{customer}/sources': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object' as const,
                      properties: {
                        object: { type: 'string' as const, enum: ['list'] },
                        data: {
                          type: 'array' as const,
                          items: { $ref: '#/components/schemas/customer' },
                        },
                        has_more: { type: 'boolean' as const },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
    const endpoints = discoverListEndpoints(spec)
    const paths = Array.from(endpoints.values()).map((e) => e.apiPath)
    expect(paths).not.toContain('/v1/customers/{customer}/sources')
  })

  it('returns empty map when spec has no paths', () => {
    const endpoints = discoverListEndpoints({ openapi: '3.0.0' })
    expect(endpoints.size).toBe(0)
  })
})
