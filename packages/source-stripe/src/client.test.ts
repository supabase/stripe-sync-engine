import { Agent } from 'node:http'
import { describe, expect, it } from 'vitest'
import { buildStripeClientOptions, type StripeClientConfigInput } from './client.js'
import { getProxyUrl } from './transport.js'

const config: StripeClientConfigInput = {
  api_key: 'sk_test_fake',
}

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

describe('buildStripeClientOptions', () => {
  it('adds a proxy agent and default timeout when HTTPS_PROXY is set', () => {
    const options = buildStripeClientOptions(config, {
      HTTPS_PROXY: 'http://proxy.example.test:8080',
    })

    expect(options.timeout).toBe(10_000)
    expect(options.httpAgent).toBeInstanceOf(Agent)
  })

  it('uses the configured timeout override', () => {
    const options = buildStripeClientOptions(config, {
      HTTPS_PROXY: 'http://proxy.example.test:8080',
      STRIPE_REQUEST_TIMEOUT_MS: '2500',
    })

    expect(options.timeout).toBe(2500)
  })

  it('keeps base_url overrides direct and does not force the proxy agent', () => {
    const options = buildStripeClientOptions(
      {
        ...config,
        base_url: 'http://localhost:12111',
      },
      {
        HTTPS_PROXY: 'http://proxy.example.test:8080',
      }
    )

    expect(options.host).toBe('localhost')
    expect(options.port).toBe(12111)
    expect(options.protocol).toBe('http')
    expect(options.httpAgent).toBeUndefined()
  })

  it('throws on an invalid timeout override', () => {
    expect(() =>
      buildStripeClientOptions(config, {
        STRIPE_REQUEST_TIMEOUT_MS: '0',
      })
    ).toThrow('STRIPE_REQUEST_TIMEOUT_MS must be a positive integer')
  })
})
