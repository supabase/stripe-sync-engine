import { describe, expect, it } from 'vitest'
import { makeClient, StripeRequestError } from './client.js'
import { getProxyUrl } from './transport.js'

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

describe('makeClient', () => {
  it('creates a client with required methods', () => {
    const client = makeClient({ api_key: 'sk_test_fake', api_version: '2025-04-30.basil' })
    expect(client.getAccount).toBeTypeOf('function')
    expect(client.listEvents).toBeTypeOf('function')
    expect(client.listWebhookEndpoints).toBeTypeOf('function')
    expect(client.createWebhookEndpoint).toBeTypeOf('function')
    expect(client.deleteWebhookEndpoint).toBeTypeOf('function')
  })

  it('throws on invalid timeout override', () => {
    expect(() =>
      makeClient(
        { api_key: 'sk_test_fake', api_version: '2025-04-30.basil' },
        { STRIPE_REQUEST_TIMEOUT_MS: '0' }
      )
    ).toThrow('STRIPE_REQUEST_TIMEOUT_MS must be a positive integer')
  })

  it('StripeRequestError includes status and stripe error details', () => {
    const err = new StripeRequestError(
      401,
      { type: 'invalid_request_error', message: 'Invalid API Key' },
      'req_123'
    )
    expect(err.status).toBe(401)
    expect(err.stripeError?.type).toBe('invalid_request_error')
    expect(err.requestId).toBe('req_123')
    expect(err.message).toBe('Invalid API Key')
  })
})
