import { describe, expect, it } from 'vitest'
import { resolveBin } from './resolver.js'
import { createSourceFromExec } from './source-exec.js'
import { createDestinationFromExec } from './destination-exec.js'
import { collectFirst } from '@stripe/sync-protocol'
import type { Message } from '@stripe/sync-protocol'

// These tests use real connector binaries (built by `pnpm build`).

describe('createSourceFromExec', () => {
  const bin = resolveBin('stripe', 'source')
  if (!bin) throw new Error('source-stripe bin not found — run pnpm build first')

  const source = createSourceFromExec(bin)

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

  it('spec() returns a valid ConnectorSpecification via async iterable', async () => {
    const specMsg = await collectFirst(source.spec(), 'spec')
    expect(specMsg).toBeDefined()
    expect(specMsg.spec.config).toBeDefined()
    expect(typeof specMsg.spec.config).toBe('object')
  })

  it('read() accepts $stdin parameter', () => {
    // Just check it accepts the parameter signature — no actual subprocess invocation
    expect(source.read.length).toBe(3)
  })
})

describe('createDestinationFromExec', () => {
  const bin = resolveBin('postgres', 'destination')
  if (!bin) throw new Error('destination-postgres bin not found — run pnpm build first')

  const dest = createDestinationFromExec(bin)

  it('has all required Destination methods', () => {
    expect(typeof dest.spec).toBe('function')
    expect(typeof dest.check).toBe('function')
    expect(typeof dest.write).toBe('function')
  })

  it('has optional methods', () => {
    expect(typeof dest.setup).toBe('function')
    expect(typeof dest.teardown).toBe('function')
  })

  it('spec() returns a valid ConnectorSpecification via async iterable', async () => {
    const specMsg = await collectFirst(dest.spec(), 'spec')
    expect(specMsg).toBeDefined()
    expect(specMsg.spec.config).toBeDefined()
    expect(typeof specMsg.spec.config).toBe('object')
  })
})

describe('error propagation', () => {
  it('throws on non-zero exit code with stderr message', async () => {
    const bin = resolveBin('stripe', 'source')
    if (!bin) throw new Error('source-stripe bin not found')

    const source = createSourceFromExec(bin)
    // check with invalid config should fail — collect the async iterable
    await expect(collectFirst(source.check({ config: {} }), 'connection_status')).rejects.toThrow()
  })
})
