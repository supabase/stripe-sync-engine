import { describe, it, expect } from 'vitest'
import { sslConfigFromConnectionString } from './sslConfigFromConnectionString.js'

describe('sslConfigFromConnectionString', () => {
  it('no sslmode → false', () => {
    expect(sslConfigFromConnectionString('postgres://user:pass@localhost:5432/mydb')).toBe(false)
  })

  it('sslmode=disable → false', () => {
    expect(
      sslConfigFromConnectionString('postgres://user:pass@localhost:5432/mydb?sslmode=disable')
    ).toBe(false)
  })

  it('sslmode=verify-full → true', () => {
    expect(
      sslConfigFromConnectionString('postgres://user:pass@host:5432/mydb?sslmode=verify-full')
    ).toBe(true)
  })

  it('sslmode=verify-ca → true', () => {
    expect(
      sslConfigFromConnectionString('postgres://user:pass@host:5432/mydb?sslmode=verify-ca')
    ).toBe(true)
  })

  it('sslmode=require → rejectUnauthorized: false', () => {
    expect(
      sslConfigFromConnectionString('postgres://user:pass@host:5432/mydb?sslmode=require')
    ).toEqual({ rejectUnauthorized: false })
  })

  it('invalid URL → false', () => {
    expect(sslConfigFromConnectionString('not-a-url')).toBe(false)
  })
})
