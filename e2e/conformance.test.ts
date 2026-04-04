import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ConnectorSpecification, collectSpec } from '@stripe/sync-protocol'
import { createConnectorCli } from '@stripe/sync-protocol/cli'
import {
  sourceTest,
  sourceTestSpec,
  destinationTest,
  destinationTestSpec,
} from '@stripe/sync-engine'

const packagesDir = resolve(import.meta.dirname, '../packages')
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
    .map((d) => ({
      name: resolvePackageName(d),
      mod: undefined as Record<string, unknown> | undefined,
    })),
  {
    name: '@stripe/sync-engine (source-test)',
    mod: { default: sourceTest, configSchema: sourceTestSpec } as Record<string, unknown>,
  },
]
const destinations = [
  ...packageDirs
    .filter((d) => d.startsWith('destination-'))
    .map((d) => ({
      name: resolvePackageName(d),
      mod: undefined as Record<string, unknown> | undefined,
    })),
  {
    name: '@stripe/sync-engine (destination-test)',
    mod: { default: destinationTest, configSchema: destinationTestSpec } as Record<string, unknown>,
  },
]

describe.each(sources)('source: $name', ({ name, mod: initialMod }) => {
  let mod: Record<string, unknown>
  beforeAll(async () => {
    mod = initialMod ?? (await import(name))
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

  it('spec() returns valid ConnectorSpecification', async () => {
    const src = mod.default as Record<string, Function>
    const { spec } = await collectSpec(src.spec())
    const result = ConnectorSpecification.safeParse(spec)
    expect(result.success, result.success ? '' : result.error.message).toBe(true)
  })

  it('spec().config is a valid JSON Schema object', async () => {
    const src = mod.default as Record<string, Function>
    const { spec } = await collectSpec(src.spec())
    expect(spec.config.type).toBe('object')
    expect(typeof spec.config.properties).toBe('object')
  })

  it('exports a named configSchema (Zod schema)', () => {
    expect(mod.configSchema, 'named export "configSchema" should exist').toBeDefined()
    expect(
      typeof (mod.configSchema as { parse?: unknown }).parse,
      'configSchema.parse should be a function'
    ).toBe('function')
  })
})

describe.each(destinations)('destination: $name', ({ name, mod: initialMod }) => {
  let mod: Record<string, unknown>
  beforeAll(async () => {
    mod = initialMod ?? (await import(name))
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

  it('spec() returns valid ConnectorSpecification', async () => {
    const dest = mod.default as Record<string, Function>
    const { spec } = await collectSpec(dest.spec())
    const result = ConnectorSpecification.safeParse(spec)
    expect(result.success, result.success ? '' : result.error.message).toBe(true)
  })

  it('spec().config is a valid JSON Schema object', async () => {
    const dest = mod.default as Record<string, Function>
    const { spec } = await collectSpec(dest.spec())
    expect(spec.config.type).toBe('object')
    expect(typeof spec.config.properties).toBe('object')
  })

  it('exports a named configSchema (Zod schema)', () => {
    expect(mod.configSchema, 'named export "configSchema" should exist').toBeDefined()
    expect(
      typeof (mod.configSchema as { parse?: unknown }).parse,
      'configSchema.parse should be a function'
    ).toBe('function')
  })
})

// MARK: - Connector bin + CLI wrapper conformance

describe.each(connectorDirs)('connector bin: %s', (dir) => {
  const pkg = readPkgJson(dir)

  it('package.json has a bin field pointing to .js', () => {
    expect(pkg.bin, 'bin field should exist').toBeDefined()
    const binPaths = Object.values(pkg.bin!)
    expect(binPaths.length).toBeGreaterThan(0)
    for (const p of binPaths) {
      expect(p, `bin path "${p}" should point to a .js file`).toMatch(/\.js$/)
    }
  })

  it('createConnectorCli registers correct commands', async () => {
    const mod = await import(pkg.name)
    const connector = mod.default as Record<string, unknown>
    const program = createConnectorCli(connector as never)
    const commandNames = Object.keys(program.subCommands ?? {})

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
