import { describe, it, expect } from 'vitest'
import { sslConfigFromConnectionString, stripSslParams } from './sslConfigFromConnectionString.js'

const base = 'postgres://user:pass@localhost:5432/mydb'
const ca = '-----BEGIN CERTIFICATE-----\nMIIBIjANBg==\n-----END CERTIFICATE-----'

describe('sslConfigFromConnectionString', () => {
  it('no sslmode → false', () => {
    expect(sslConfigFromConnectionString(base)).toBe(false)
  })

  it('sslmode=disable → false', () => {
    expect(sslConfigFromConnectionString(`${base}?sslmode=disable`)).toBe(false)
  })

  it('sslmode=require → rejectUnauthorized: false', () => {
    expect(sslConfigFromConnectionString(`${base}?sslmode=require`)).toEqual({
      rejectUnauthorized: false,
    })
  })

  it('sslmode=verify-full without CA → rejectUnauthorized: true, no ca', () => {
    expect(sslConfigFromConnectionString(`${base}?sslmode=verify-full`)).toEqual({
      rejectUnauthorized: true,
    })
  })

  it('sslmode=verify-full with CA → includes ca', () => {
    const result = sslConfigFromConnectionString(`${base}?sslmode=verify-full`, { sslCaPem: ca })
    expect(result).toEqual({ rejectUnauthorized: true, ca })
  })

  it('sslmode=verify-ca without CA → rejectUnauthorized: true, skips hostname check', () => {
    const result = sslConfigFromConnectionString(`${base}?sslmode=verify-ca`)
    expect(result).toMatchObject({ rejectUnauthorized: true })
    expect(typeof (result as { checkServerIdentity?: unknown }).checkServerIdentity).toBe(
      'function'
    )
  })

  it('sslmode=verify-ca with CA → includes ca, skips hostname check', () => {
    const result = sslConfigFromConnectionString(`${base}?sslmode=verify-ca`, { sslCaPem: ca })
    expect(result).toMatchObject({ rejectUnauthorized: true, ca })
    expect(typeof (result as { checkServerIdentity?: unknown }).checkServerIdentity).toBe(
      'function'
    )
  })

  it('invalid URL → false', () => {
    expect(sslConfigFromConnectionString('not-a-url')).toBe(false)
  })
})

describe('stripSslParams', () => {
  it('removes sslmode, sslrootcert, sslcert, sslkey', () => {
    const url = `${base}?sslmode=verify-full&sslrootcert=/tmp/ca.pem&sslcert=/tmp/client.pem&sslkey=/tmp/key.pem`
    expect(stripSslParams(url)).toBe(base)
  })

  it('preserves other params', () => {
    expect(stripSslParams(`${base}?sslmode=require&connect_timeout=10`)).toBe(
      `${base}?connect_timeout=10`
    )
  })

  it('invalid URL → returns as-is', () => {
    expect(stripSslParams('not-a-url')).toBe('not-a-url')
  })
})
