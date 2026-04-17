import { describe, expect, it } from 'vitest'
import {
  getHttpsProxyAgentForTarget,
  getProxyUrl,
  getProxyUrlForTarget,
  parsePositiveInteger,
  shouldBypassProxy,
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
