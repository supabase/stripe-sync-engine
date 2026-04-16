import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeClient, StripeRequestError } from './client.js'
import { getProxyUrl } from './transport.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = originalFetch
})

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

  it('StripeRequestError includes status and error message from body', () => {
    const err = new StripeRequestError(
      401,
      { error: { type: 'invalid_request_error', message: 'Invalid API Key' } },
      'GET',
      '/v1/account'
    )
    expect(err.status).toBe(401)
    expect(err.message).toBe('Invalid API Key')
  })

  it('retries transient GET failures and eventually succeeds', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { type: 'api_error', message: 'Temporary outage' },
          }),
          { status: 500 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'acct_test', object: 'account', created: 123 }), {
          status: 200,
        })
      )
    globalThis.fetch = fetchMock

    const client = makeClient({ api_key: 'sk_test_fake', base_url: 'http://stripe.test' }, {})
    const pending = client.getAccount()
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toMatchObject({ id: 'acct_test', created: 123 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops retrying when the pipeline signal aborts during backoff', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { type: 'api_error', message: 'Temporary outage' },
          }),
          { status: 500 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'acct_test', object: 'account', created: 123 }), {
          status: 200,
        })
      )
    globalThis.fetch = fetchMock

    const ac = new AbortController()
    const client = makeClient(
      { api_key: 'sk_test_fake', api_version: '2025-04-30.basil', base_url: 'http://stripe.test' },
      {},
      ac.signal
    )

    const pending = client.getAccount()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const settled = vi.fn()
    pending.then(
      (value) => settled(value),
      (error) => settled(error)
    )

    ac.abort()
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled.mock.calls[0]?.[0]).toMatchObject({ name: 'AbortError' })
  })

  it('does not retry auth failures on GET requests', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: 'Invalid API Key provided: sk_test_bad',
          },
        }),
        { status: 401 }
      )
    )
    globalThis.fetch = fetchMock

    const client = makeClient({ api_key: 'sk_test_bad', base_url: 'http://stripe.test' }, {})

    await expect(client.getAccount()).rejects.toThrow('Invalid API Key provided: sk_test_bad')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
