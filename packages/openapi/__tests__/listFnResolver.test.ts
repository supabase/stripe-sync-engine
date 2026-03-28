import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildListFn, buildRetrieveFn, discoverListEndpoints } from '../listFnResolver'
import { minimalStripeOpenApiSpec } from './fixtures/minimalSpec'

describe('discoverListEndpoints', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

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

  it('routes list and retrieve fetches through the proxy helper', async () => {
    const originalHttpsProxy = process.env.HTTPS_PROXY
    process.env.HTTPS_PROXY = 'http://proxy.example.test:8080'

    const fetchMock = vi.fn(async (_input: URL | string, init?: RequestInit) => {
      expect(init?.dispatcher).toBeDefined()
      return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const list = buildListFn('sk_test_fake', '/v1/customers')
      const retrieve = buildRetrieveFn('sk_test_fake', '/v1/customers')

      await list({ limit: 1 })
      await retrieve('cus_123')

      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      if (originalHttpsProxy === undefined) {
        delete process.env.HTTPS_PROXY
      } else {
        process.env.HTTPS_PROXY = originalHttpsProxy
      }
    }
  })

  it('bypasses the proxy for localhost base URLs', async () => {
    const originalHttpsProxy = process.env.HTTPS_PROXY
    process.env.HTTPS_PROXY = 'http://proxy.example.test:8080'

    const fetchMock = vi.fn(async (_input: URL | string, init?: RequestInit) => {
      expect(init?.dispatcher).toBeUndefined()
      return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const list = buildListFn('sk_test_fake', '/v1/customers', undefined, 'http://localhost:12111')
      await list({ limit: 1 })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      if (originalHttpsProxy === undefined) {
        delete process.env.HTTPS_PROXY
      } else {
        process.env.HTTPS_PROXY = originalHttpsProxy
      }
    }
  })
})
