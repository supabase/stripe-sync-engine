import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ConnectorSpecification } from '@stripe/sync-protocol'

const packagesDir = resolve(import.meta.dirname, '../../packages')
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

function resolvePackageName(dir: string): string {
  const pkgJson = JSON.parse(readFileSync(resolve(packagesDir, dir, 'package.json'), 'utf-8'))
  return pkgJson.name as string
}

const sources = [
  ...packageDirs
    .filter((d) => d.startsWith('source-'))
    .map((d) => ({ name: resolvePackageName(d) })),
  { name: '@stripe/sync-protocol/source-test' },
]
const destinations = [
  ...packageDirs
    .filter((d) => d.startsWith('destination-'))
    .map((d) => ({ name: resolvePackageName(d) })),
  { name: '@stripe/sync-protocol/destination-test' },
]

describe.each(sources)('source: $name', ({ name }) => {
  let mod: Record<string, unknown>
  beforeAll(async () => {
    mod = await import(name)
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

describe.each(destinations)('destination: $name', ({ name }) => {
  let mod: Record<string, unknown>
  beforeAll(async () => {
    mod = await import(name)
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
