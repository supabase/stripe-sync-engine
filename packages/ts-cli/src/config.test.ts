import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { envPrefix, configFromFile, mergeConfig } from './config.js'

// ---------------------------------------------------------------------------
// envPrefix
// ---------------------------------------------------------------------------

describe('envPrefix', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Save any env vars we'll touch
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('TESTPFX_') || key === 'TESTPFXEXTRA') {
        saved[key] = process.env[key]
      }
    }
  })

  afterEach(() => {
    // Clean up test env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('TESTPFX_') || key === 'TESTPFXEXTRA') {
        delete process.env[key]
      }
    }
    // Restore originals
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('scans env vars with matching prefix', () => {
    process.env.TESTPFX_API_KEY = 'sk_test_123'
    process.env.TESTPFX_BASE_URL = 'http://localhost'

    const result = envPrefix('TESTPFX')
    expect(result).toEqual({
      api_key: 'sk_test_123',
      base_url: 'http://localhost',
    })
  })

  it('lowercases field names', () => {
    process.env.TESTPFX_MY_FIELD = 'value'
    expect(envPrefix('TESTPFX')).toEqual({ my_field: 'value' })
  })

  it('JSON-parses values where possible', () => {
    process.env.TESTPFX_BOOL = 'true'
    process.env.TESTPFX_NUM = '123'
    process.env.TESTPFX_OBJ = '{"a":1}'
    process.env.TESTPFX_STR = 'hello'

    const result = envPrefix('TESTPFX')
    expect(result.bool).toBe(true)
    expect(result.num).toBe(123)
    expect(result.obj).toEqual({ a: 1 })
    expect(result.str).toBe('hello')
  })

  it('returns empty when no matching vars', () => {
    expect(envPrefix('NONEXISTENT')).toEqual({})
  })

  it('does not match partial prefix (TESTPFX does not match TESTPFXEXTRA)', () => {
    process.env.TESTPFXEXTRA = 'should_not_match'
    process.env.TESTPFX_REAL = 'should_match'

    const result = envPrefix('TESTPFX')
    expect(result).toEqual({ real: 'should_match' })
    expect(result).not.toHaveProperty('extra')
  })
})

// ---------------------------------------------------------------------------
// configFromFile
// ---------------------------------------------------------------------------

describe('configFromFile', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'config-test-'))
  })

  it('returns {} when path is undefined', () => {
    expect(configFromFile(undefined)).toEqual({})
  })

  it('reads a JSON config file', () => {
    const filePath = join(dir, 'config.json')
    writeFileSync(filePath, JSON.stringify({ api_key: 'sk_test', port: 3000 }))

    expect(configFromFile(filePath)).toEqual({ api_key: 'sk_test', port: 3000 })
  })

  it('throws on missing file', () => {
    expect(() => configFromFile(join(dir, 'nope.json'))).toThrow('Config file not found')
  })

  it('throws on invalid JSON', () => {
    const filePath = join(dir, 'bad.json')
    writeFileSync(filePath, 'not json {{{')

    expect(() => configFromFile(filePath)).toThrow('Invalid JSON in config file')
  })

  it('throws on non-object JSON', () => {
    const filePath = join(dir, 'array.json')
    writeFileSync(filePath, '[1, 2, 3]')

    expect(() => configFromFile(filePath)).toThrow('must contain a JSON object')
  })
})

// ---------------------------------------------------------------------------
// mergeConfig
// ---------------------------------------------------------------------------

describe('mergeConfig', () => {
  it('first source wins per key', () => {
    const result = mergeConfig({ a: 1, b: 2 }, { a: 99, c: 3 })
    expect(result).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('skips undefined sources', () => {
    const result = mergeConfig(undefined, { a: 1 }, undefined, { b: 2 })
    expect(result).toEqual({ a: 1, b: 2 })
  })

  it('returns empty when all sources are empty or undefined', () => {
    expect(mergeConfig(undefined, {}, undefined)).toEqual({})
  })

  it('handles single source', () => {
    expect(mergeConfig({ x: 42 })).toEqual({ x: 42 })
  })
})
