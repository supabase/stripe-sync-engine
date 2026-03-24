import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ConnectorSpecification } from '@stripe/protocol'
import { createConnectorCli } from '@stripe/protocol/cli'

const packagesDir = resolve(import.meta.dirname, '../../packages')
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

interface PkgJson {
  name: string
  bin?: Record<string, string>
}

function readPkgJson(dir: string): PkgJson {
  return JSON.parse(readFileSync(resolve(packagesDir, dir, 'package.json'), 'utf-8')) as PkgJson
}

function resolvePackageName(dir: string): string {
  return readPkgJson(dir).name
}

const connectorDirs = packageDirs.filter(
  (d) => d.startsWith('source-') || d.startsWith('destination-')
)

const sources = [
  ...packageDirs
    .filter((d) => d.startsWith('source-'))
    .map((d) => ({ name: resolvePackageName(d) })),
  { name: '@stripe/stateless-sync/source-test' },
]
const destinations = [
  ...packageDirs
    .filter((d) => d.startsWith('destination-'))
    .map((d) => ({ name: resolvePackageName(d) })),
  { name: '@stripe/stateless-sync/destination-test' },
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

// MARK: - Connector bin + CLI wrapper conformance

describe.each(connectorDirs)('connector bin: %s', (dir) => {
  const pkg = readPkgJson(dir)

  it('package.json has a bin field', () => {
    expect(pkg.bin, 'bin field should exist').toBeDefined()
    expect(typeof pkg.bin).toBe('object')
    const binPaths = Object.values(pkg.bin!)
    expect(binPaths.length).toBeGreaterThan(0)
    for (const p of binPaths) {
      expect(p).toMatch(/\.js$/)
    }
  })

  it('createConnectorCli registers correct commands', async () => {
    const mod = await import(pkg.name)
    const connector = mod.default as Record<string, unknown>
    const program = createConnectorCli(connector as never)
    const commandNames = program.commands.map((c) => c.name())

    // Both source and destination get spec + check
    expect(commandNames).toContain('spec')
    expect(commandNames).toContain('check')

    const isSource =
      typeof connector.discover === 'function' && typeof connector.read === 'function'
    const isDestination = typeof connector.write === 'function'

    if (isSource) {
      expect(commandNames).toContain('discover')
      expect(commandNames).toContain('read')
    }
    if (isDestination) {
      expect(commandNames).toContain('write')
    }
  })
})
