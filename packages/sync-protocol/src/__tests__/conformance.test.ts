import { readdirSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { beforeAll, describe, expect, it } from 'vitest'
import { ConnectorSpecification } from '../protocol'

// __tests__ → src → sync-protocol → packages
const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

const sources = packages.filter((d) => d.startsWith('source-'))
const destinations = packages.filter((d) => d.startsWith('destination-'))

describe.each(sources)('source: %s', (pkg) => {
  let mod: Record<string, unknown>
  beforeAll(async () => {
    mod = await import(resolve(packagesDir, pkg, 'src/index.ts'))
  })

  it('has a default export', () => {
    expect(mod.default).toBeDefined()
    expect(typeof mod.default).toBe('object')
    expect(mod.default).not.toBeNull()
  })

  it('has required methods: spec, check, discover, read', () => {
    const src = mod.default as Record<string, unknown>
    for (const method of ['spec', 'check', 'discover', 'read']) {
      expect(typeof src[method], `${method}() should be a function`).toBe('function')
    }
  })

  it('optional methods are functions if present', () => {
    const src = mod.default as Record<string, unknown>
    for (const method of ['setup', 'teardown']) {
      if (method in src) {
        expect(typeof src[method], `${method} is present but not a function`).toBe('function')
      }
    }
  })

  it('spec() returns valid ConnectorSpecification', () => {
    const src = mod.default as Record<string, Function>
    const result = ConnectorSpecification.safeParse(src.spec())
    expect(result.success, result.success ? '' : result.error.message).toBe(true)
  })

  it('spec().config is a valid JSON Schema object', () => {
    const src = mod.default as Record<string, Function>
    const spec = src.spec() as { config: Record<string, unknown> }
    expect(spec.config.type).toBe('object')
    expect(typeof spec.config.properties).toBe('object')
  })

  it('exports a named spec (Zod schema)', () => {
    expect(mod.spec, 'named export "spec" should exist').toBeDefined()
    expect(typeof (mod.spec as { parse?: unknown }).parse, 'spec.parse should be a function').toBe(
      'function'
    )
  })
})

describe.each(destinations)('destination: %s', (pkg) => {
  let mod: Record<string, unknown>
  beforeAll(async () => {
    mod = await import(resolve(packagesDir, pkg, 'src/index.ts'))
  })

  it('has a default export', () => {
    expect(mod.default).toBeDefined()
    expect(typeof mod.default).toBe('object')
    expect(mod.default).not.toBeNull()
  })

  it('has required methods: spec, check, write', () => {
    const dest = mod.default as Record<string, unknown>
    for (const method of ['spec', 'check', 'write']) {
      expect(typeof dest[method], `${method}() should be a function`).toBe('function')
    }
  })

  it('optional methods are functions if present', () => {
    const dest = mod.default as Record<string, unknown>
    for (const method of ['setup', 'teardown']) {
      if (method in dest) {
        expect(typeof dest[method], `${method} is present but not a function`).toBe('function')
      }
    }
  })

  it('spec() returns valid ConnectorSpecification', () => {
    const dest = mod.default as Record<string, Function>
    const result = ConnectorSpecification.safeParse(dest.spec())
    expect(result.success, result.success ? '' : result.error.message).toBe(true)
  })

  it('spec().config is a valid JSON Schema object', () => {
    const dest = mod.default as Record<string, Function>
    const spec = dest.spec() as { config: Record<string, unknown> }
    expect(spec.config.type).toBe('object')
    expect(typeof spec.config.properties).toBe('object')
  })

  it('exports a named spec (Zod schema)', () => {
    expect(mod.spec, 'named export "spec" should exist').toBeDefined()
    expect(typeof (mod.spec as { parse?: unknown }).parse, 'spec.parse should be a function').toBe(
      'function'
    )
  })
})
