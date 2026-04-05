import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  fetchWithProxy,
  getHttpsProxyAgentForTarget,
  getProxyUrl,
  getProxyUrlForTarget,
  parsePositiveInteger,
  shouldBypassProxy,
  withFetchProxy,
} from './transport.js'

describe('getProxyUrl', () => {
  it('prefers HTTPS_PROXY over HTTP_PROXY', () => {
    expect(
      getProxyUrl({
        HTTPS_PROXY: 'http://secure-proxy.example.test:8080',
        HTTP_PROXY: 'http://fallback-proxy.example.test:8080',
      })
    ).toBe('http://secure-proxy.example.test:8080')
  })

  it('returns undefined when no proxy env var is set', () => {
    expect(getProxyUrl({})).toBeUndefined()
  })
})

describe('getProxyUrlForTarget', () => {
  it('returns the proxy for external targets', () => {
    expect(
      getProxyUrlForTarget('https://api.stripe.com/v1/customers', {
        HTTPS_PROXY: 'http://proxy.example.test:8080',
      })
    ).toBe('http://proxy.example.test:8080')
  })

  it('bypasses the proxy for localhost and NO_PROXY matches', () => {
    expect(
      getProxyUrlForTarget('http://localhost:12111/v1/customers', {
        HTTPS_PROXY: 'http://proxy.example.test:8080',
      })
    ).toBeUndefined()

    expect(
      getProxyUrlForTarget('https://sync-engine-srv.service.envoy/health', {
        HTTPS_PROXY: 'http://proxy.example.test:8080',
        NO_PROXY: '.service.envoy,10.0.0.0/8',
      })
    ).toBeUndefined()

    expect(
      getProxyUrlForTarget('http://10.42.0.15:8080/health', {
        HTTPS_PROXY: 'http://proxy.example.test:8080',
        NO_PROXY: '.service.envoy,10.0.0.0/8',
      })
    ).toBeUndefined()
  })
})

describe('shouldBypassProxy', () => {
  it('supports wildcard-style domain matches', () => {
    expect(
      shouldBypassProxy('https://api.internal.stripe.com', {
        NO_PROXY: '.stripe.com',
      })
    ).toBe(true)
  })
})

describe('parsePositiveInteger', () => {
  it('uses the default value when env is not set', () => {
    expect(parsePositiveInteger('TEST_TIMEOUT', undefined, 10_000)).toBe(10_000)
  })

  it('throws on invalid values', () => {
    expect(() => parsePositiveInteger('TEST_TIMEOUT', '0', 10_000)).toThrow(
      'TEST_TIMEOUT must be a positive integer'
    )
  })
})

describe('withFetchProxy', () => {
  it('adds a dispatcher when a proxy env var is set', () => {
    const init = withFetchProxy(
      {
        headers: { Accept: 'application/json' },
      },
      {
        HTTPS_PROXY: 'http://proxy.example.test:8080',
      }
    )

    expect(init.headers).toEqual({ Accept: 'application/json' })
    expect(init.dispatcher).toBeDefined()
  })

  it('leaves request init unchanged when no proxy env var is set', () => {
    const init: RequestInit = { method: 'POST' }

    expect(withFetchProxy(init, {})).toBe(init)
  })
})

describe('fetchWithProxy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls fetch without a dispatcher when no proxy is configured', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    await fetchWithProxy('https://api.stripe.com/v1/customers', {}, {})

    expect(mockFetch).toHaveBeenCalledOnce()
    const [, init] = mockFetch.mock.calls[0]
    expect((init as any)?.dispatcher).toBeUndefined()
  })

  it('calls fetch with a proxy dispatcher when HTTPS_PROXY is set', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    await fetchWithProxy('https://api.stripe.com/v1/customers', {}, {
      HTTPS_PROXY: 'http://proxy.example.test:8080',
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [, init] = mockFetch.mock.calls[0]
    expect((init as any).dispatcher).toBeDefined()
  })

  it('bypasses proxy for localhost even when HTTPS_PROXY is set', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    await fetchWithProxy('http://localhost:12111/v1/customers', {}, {
      HTTPS_PROXY: 'http://proxy.example.test:8080',
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [, init] = mockFetch.mock.calls[0]
    expect((init as any)?.dispatcher).toBeUndefined()
  })

  it('bypasses proxy for NO_PROXY domains', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    await fetchWithProxy('https://stripe-sync.dev/stripe-api-specs/manifest.json', {}, {
      HTTPS_PROXY: 'http://proxy.example.test:8080',
      NO_PROXY: 'stripe-sync.dev',
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [, init] = mockFetch.mock.calls[0]
    expect((init as any)?.dispatcher).toBeUndefined()
  })
})

describe('getHttpsProxyAgentForTarget', () => {
  it('returns an agent only when the target should use the proxy', () => {
    expect(
      getHttpsProxyAgentForTarget('https://api.stripe.com/v1/customers', {
        HTTPS_PROXY: 'http://proxy.example.test:8080',
      })
    ).toBeDefined()

    expect(
      getHttpsProxyAgentForTarget('http://localhost:12111/v1/customers', {
        HTTPS_PROXY: 'http://proxy.example.test:8080',
      })
    ).toBeUndefined()
  })
})
