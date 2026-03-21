import { describe, expect, it } from 'vitest'
import { testSource, testDestination } from '@stripe/stateless-sync'
import type { ConnectorResolver, StateMessage, Message } from '@stripe/sync-engine-stateless'
import { memoryCredentialStore, memoryConfigStore } from '@stripe/stateful-sync'
import type { Credential } from '@stripe/stateful-sync'
import { setupSync, teardownSync, checkSync, readSync, writeSync, runSync } from './run'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCred(id: string, type: string): Credential {
  return {
    id,
    type,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

/** Re-iterable async iterable from an array — each `for await` gets a fresh iterator. */
function toAsync<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          if (i < items.length) return { value: items[i++], done: false as const }
          return { value: undefined, done: true as const }
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSync', () => {
  it('yields state messages from a successful sync', async () => {
    const resolver: ConnectorResolver = {
      resolveSource: async () => testSource,
      resolveDestination: async () => testDestination,
    }

    const credentials = memoryCredentialStore({
      'src-cred': makeCred('src-cred', 'test'),
      'dst-cred': makeCred('dst-cred', 'test'),
    })

    const configs = memoryConfigStore({
      test_sync: {
        id: 'test_sync',
        source: { type: 'test', credential_id: 'src-cred', streams: { customers: {} } },
        destination: { type: 'test', credential_id: 'dst-cred' },
      },
    })

    const messages: StateMessage[] = []
    for await (const msg of runSync({
      syncId: 'test_sync',
      connectors: resolver,
      credentials,
      configs,
      $stdin: toAsync([
        {
          type: 'record',
          stream: 'customers',
          data: { id: 'cus_1', name: 'Alice' },
          emitted_at: Date.now(),
        },
        { type: 'state', stream: 'customers', data: { status: 'complete' } },
      ]),
    })) {
      messages.push(msg)
    }

    expect(messages).toHaveLength(1)
    expect(messages[0]!.type).toBe('state')
    expect(messages[0]!.stream).toBe('customers')
    expect(messages[0]!.data).toEqual({ status: 'complete' })
  })

  it('pipeline produces state for each stream', async () => {
    const resolver: ConnectorResolver = {
      resolveSource: async () => testSource,
      resolveDestination: async () => testDestination,
    }

    const credentials = memoryCredentialStore({
      'src-cred': makeCred('src-cred', 'test'),
      'dst-cred': makeCred('dst-cred', 'test'),
    })

    const configs = memoryConfigStore({
      test_sync: {
        id: 'test_sync',
        source: {
          type: 'test',
          credential_id: 'src-cred',
          streams: { customers: {}, invoices: {} },
        },
        destination: { type: 'test', credential_id: 'dst-cred' },
      },
    })

    const messages: StateMessage[] = []
    for await (const msg of runSync({
      syncId: 'test_sync',
      connectors: resolver,
      credentials,
      configs,
      $stdin: toAsync([
        { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: Date.now() },
        { type: 'state', stream: 'customers', data: { status: 'complete' } },
        { type: 'record', stream: 'invoices', data: { id: 'inv_1' }, emitted_at: Date.now() },
        { type: 'state', stream: 'invoices', data: { status: 'complete' } },
      ]),
    })) {
      messages.push(msg)
    }

    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.stream).sort()).toEqual(['customers', 'invoices'])
  })
})

// ---------------------------------------------------------------------------
// setupSync / teardownSync / checkSync / readSync / writeSync
// ---------------------------------------------------------------------------

function makeOpts(extra: Partial<Parameters<typeof runSync>[0]> = {}) {
  const resolver: ConnectorResolver = {
    resolveSource: async () => testSource,
    resolveDestination: async () => testDestination,
  }
  const credentials = memoryCredentialStore({
    'src-cred': makeCred('src-cred', 'test'),
    'dst-cred': makeCred('dst-cred', 'test'),
  })
  const configs = memoryConfigStore({
    test_sync: {
      id: 'test_sync',
      source: { type: 'test', credential_id: 'src-cred', streams: { customers: {} } },
      destination: { type: 'test', credential_id: 'dst-cred' },
    },
  })
  return {
    syncId: 'test_sync',
    connectors: resolver,
    credentials,
    configs,
    ...extra,
  }
}

describe('setupSync', () => {
  it('resolves without error', async () => {
    await expect(setupSync(makeOpts())).resolves.toBeUndefined()
  })
})

describe('teardownSync', () => {
  it('resolves without error', async () => {
    await expect(teardownSync(makeOpts())).resolves.toBeUndefined()
  })
})

describe('checkSync', () => {
  it('returns source and destination check results', async () => {
    const result = await checkSync(makeOpts())
    expect(result.source.status).toBe('succeeded')
    expect(result.destination.status).toBe('succeeded')
  })
})

describe('readSync', () => {
  it('yields messages from source', async () => {
    const $stdin = toAsync([
      { type: 'record' as const, stream: 'customers', data: { id: 'c1' }, emitted_at: 0 },
      { type: 'state' as const, stream: 'customers', data: { cursor: 'abc' } },
    ])
    const msgs: Message[] = []
    for await (const msg of readSync(makeOpts({ $stdin }))) {
      msgs.push(msg)
    }
    expect(msgs.length).toBeGreaterThan(0)
  })
})

describe('writeSync', () => {
  it('yields state messages after writing records', async () => {
    const $stdin = toAsync([
      { type: 'record' as const, stream: 'customers', data: { id: 'c1' }, emitted_at: 0 },
      { type: 'state' as const, stream: 'customers', data: { cursor: 'z' } },
    ] as Message[])
    const msgs: StateMessage[] = []
    for await (const msg of writeSync(makeOpts({ $stdin }))) {
      msgs.push(msg)
    }
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.type).toBe('state')
    expect(msgs[0]!.stream).toBe('customers')
  })

  it('throws when $stdin is not provided', async () => {
    await expect(async () => {
      for await (const _ of writeSync(makeOpts())) {
        // nothing
      }
    }).rejects.toThrow('$stdin required')
  })
})
