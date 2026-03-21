import { describe, expect, it } from 'vitest'
import { resolveBin } from './loader'
import { spawnSource, spawnDestination } from './subprocess'

// These tests use real connector binaries (built by `pnpm build`).

describe('spawnSource', () => {
  const bin = resolveBin('stripe', 'source')
  if (!bin) throw new Error('source-stripe bin not found — run pnpm build first')

  const source = spawnSource(bin)

  it('has all required Source methods', () => {
    expect(typeof source.spec).toBe('function')
    expect(typeof source.check).toBe('function')
    expect(typeof source.discover).toBe('function')
    expect(typeof source.read).toBe('function')
  })

  it('has optional methods', () => {
    expect(typeof source.setup).toBe('function')
    expect(typeof source.teardown).toBe('function')
  })

  it('spec() returns a valid ConnectorSpecification', () => {
    const spec = source.spec()
    expect(spec).toBeDefined()
    expect(spec.config).toBeDefined()
    expect(typeof spec.config).toBe('object')
  })
})

describe('spawnDestination', () => {
  const bin = resolveBin('postgres', 'destination')
  if (!bin) throw new Error('destination-postgres bin not found — run pnpm build first')

  const dest = spawnDestination(bin)

  it('has all required Destination methods', () => {
    expect(typeof dest.spec).toBe('function')
    expect(typeof dest.check).toBe('function')
    expect(typeof dest.write).toBe('function')
  })

  it('has optional methods', () => {
    expect(typeof dest.setup).toBe('function')
    expect(typeof dest.teardown).toBe('function')
  })

  it('spec() returns a valid ConnectorSpecification', () => {
    const spec = dest.spec()
    expect(spec).toBeDefined()
    expect(spec.config).toBeDefined()
    expect(typeof spec.config).toBe('object')
  })
})

describe('error propagation', () => {
  it('throws on non-zero exit code with stderr message', async () => {
    // Use a bin that will exit non-zero — pass a bad command
    const bin = resolveBin('stripe', 'source')
    if (!bin) throw new Error('source-stripe bin not found')

    const source = spawnSource(bin)
    // check with invalid config should fail
    await expect(source.check({ config: {} })).rejects.toThrow()
  })
})
