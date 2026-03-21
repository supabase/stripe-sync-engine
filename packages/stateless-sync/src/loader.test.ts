import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it, vi } from 'vitest'
import { resolveSpecifier, loadConnector, createConnectorResolver } from './loader'
import { testSource } from './source-test'
import { testDestination } from './destination-test'

const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

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
// loadConnector
// ---------------------------------------------------------------------------

describe('loadConnector', () => {
  it('loads a source connector from a file path', async () => {
    const specifier = resolve(packagesDir, 'source-stripe/src/index.ts')
    const connector = await loadConnector(specifier, 'source')
    expect(connector).toBeDefined()
    expect(typeof connector.spec).toBe('function')
    expect(typeof connector.check).toBe('function')
  })

  it('loads a destination connector from a file path', async () => {
    const specifier = resolve(packagesDir, 'destination-postgres/src/index.ts')
    const connector = await loadConnector(specifier, 'destination')
    expect(typeof connector.spec).toBe('function')
  })

  it('throws descriptive error for missing package without installFn', async () => {
    await expect(loadConnector('@stripe/destination-nonexistent', 'destination')).rejects.toThrow(
      /not found.*pnpm add/
    )
  })

  it('rejects module that does not look like a connector', async () => {
    // 'zod' exports functions but not spec/check — should fail validation
    await expect(loadConnector('zod', 'source')).rejects.toThrow(/failed source conformance check/)
  })

  it('rejects module with only spec+check but missing discover/read as a source', async () => {
    // A destination has spec+check+write but lacks discover+read — loading as source should fail
    const specifier = resolve(packagesDir, 'destination-postgres/src/index.ts')
    await expect(loadConnector(specifier, 'source')).rejects.toThrow(
      /missing required method: discover/
    )
  })

  it('calls installFn when module is not found and installFn is provided', async () => {
    const installFn = vi.fn()
    // The installFn is called but the module still won't exist after a mock install,
    // so the retry import will also fail — we just verify installFn was invoked
    await expect(
      loadConnector('@stripe/destination-nonexistent', 'destination', { installFn })
    ).rejects.toThrow()
    expect(installFn).toHaveBeenCalledWith('@stripe/destination-nonexistent')
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

  it('preloaded connectors take priority over dynamic loading', async () => {
    const resolver = createConnectorResolver({
      sources: { stripe: testSource },
    })
    // Should return preloaded testSource, not try to dynamically load @stripe/source-stripe
    const source = await resolver.resolveSource('stripe')
    expect(source).toBe(testSource)
  })

  it('throws for unknown connector without installFn', async () => {
    const resolver = createConnectorResolver({})
    await expect(resolver.resolveDestination('nonexistent')).rejects.toThrow(/not found/)
  })

  it('passes installFn through to loadConnector', async () => {
    const installFn = vi.fn()
    const resolver = createConnectorResolver({ installFn })
    // Will fail because the package doesn't exist, but installFn should be called
    await expect(resolver.resolveDestination('nonexistent')).rejects.toThrow()
    expect(installFn).toHaveBeenCalledWith('@stripe/destination-nonexistent')
  })
})
