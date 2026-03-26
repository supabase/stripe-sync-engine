import { describe, expect, it } from 'vitest'
import { getProxyUrl, parsePositiveInteger, withFetchProxy } from './transport.js'

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
