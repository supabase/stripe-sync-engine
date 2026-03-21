import { existsSync, readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSpecifier, resolveBin, createConnectorResolver } from './loader'
import { testSource } from './source-test'
import { testDestination } from './destination-test'

// ---------------------------------------------------------------------------
// resolveSpecifier
// ---------------------------------------------------------------------------

describe('resolveSpecifier', () => {
  it('resolves bare source name to scoped package', () => {
    expect(resolveSpecifier('stripe', 'source')).toBe('@stripe/source-stripe')
  })

  it('resolves bare destination name to scoped package', () => {
    expect(resolveSpecifier('postgres', 'destination')).toBe('@stripe/destination-postgres')
  })

  it('passes through scoped packages (contains /)', () => {
    expect(resolveSpecifier('@myorg/custom-dest', 'destination')).toBe('@myorg/custom-dest')
  })

  it('passes through relative paths', () => {
    expect(resolveSpecifier('./my-local-source.ts', 'source')).toBe('./my-local-source.ts')
  })

  it('passes through absolute paths', () => {
    expect(resolveSpecifier('/opt/connectors/source.js', 'source')).toBe(
      '/opt/connectors/source.js'
    )
  })
})

// ---------------------------------------------------------------------------
// resolveBin
// ---------------------------------------------------------------------------

describe('resolveBin', () => {
  it('returns a path for an installed connector bin', () => {
    // source-stripe should be installed as a devDependency of this package
    const binDir = join(process.cwd(), 'node_modules', '.bin')
    const binDirExists = existsSync(binDir)
    const binContents = binDirExists ? readdirSync(binDir).filter((f) => f.includes('source')) : []
    const sourceStripePath = join(binDir, 'source-stripe')
    let symlinkInfo = 'n/a'
    try {
      const stat = lstatSync(sourceStripePath)
      symlinkInfo = `isSymlink=${stat.isSymbolicLink()}, isFile=${stat.isFile()}`
    } catch {
      symlinkInfo = 'lstat failed (not found)'
    }

    const bin = resolveBin('stripe', 'source')
    expect(
      bin,
      [
        `cwd=${process.cwd()}`,
        `.bin exists=${binDirExists}`,
        `.bin source entries=${JSON.stringify(binContents)}`,
        `source-stripe: ${symlinkInfo}`,
        `existsSync(source-stripe)=${existsSync(sourceStripePath)}`,
      ].join(', ')
    ).toBeDefined()
    expect(existsSync(bin!)).toBe(true)
  })

  it('returns undefined for a non-existent connector', () => {
    const bin = resolveBin('nonexistent', 'source')
    expect(bin).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// createConnectorResolver
// ---------------------------------------------------------------------------

describe('createConnectorResolver', () => {
  it('returns preloaded source immediately', async () => {
    const resolver = createConnectorResolver({
      sources: { stripe: testSource },
    })
    const source = await resolver.resolveSource('stripe')
    expect(source).toBe(testSource)
  })

  it('returns preloaded destination immediately', async () => {
    const resolver = createConnectorResolver({
      destinations: { postgres: testDestination },
    })
    const dest = await resolver.resolveDestination('postgres')
    expect(dest).toBe(testDestination)
  })

  it('caches resolved connectors — same instance on second call', async () => {
    const resolver = createConnectorResolver({
      sources: { stripe: testSource },
    })
    const first = await resolver.resolveSource('stripe')
    const second = await resolver.resolveSource('stripe')
    expect(first).toBe(second)
  })

  it('preloaded connectors take priority over subprocess fallback', async () => {
    const resolver = createConnectorResolver({
      sources: { stripe: testSource },
    })
    // Should return preloaded testSource, not spawn a subprocess
    const source = await resolver.resolveSource('stripe')
    expect(source).toBe(testSource)
  })

  it('falls back to subprocess for installed connector without preload', async () => {
    const resolver = createConnectorResolver({})
    // source-stripe bin is installed in this monorepo
    const source = await resolver.resolveSource('stripe')
    expect(source).toBeDefined()
    expect(typeof source.spec).toBe('function')
    expect(typeof source.check).toBe('function')
    expect(typeof source.discover).toBe('function')
    expect(typeof source.read).toBe('function')
  })

  it('throws for unknown connector', async () => {
    const resolver = createConnectorResolver({})
    await expect(resolver.resolveDestination('nonexistent')).rejects.toThrow(/not found/)
  })
})
