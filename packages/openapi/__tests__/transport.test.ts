import { describe, expect, it } from 'vitest'
import {
  getProxyUrl,
  getProxyUrlForTarget,
  shouldBypassProxy,
  withFetchProxy,
} from '../transport.js'

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
