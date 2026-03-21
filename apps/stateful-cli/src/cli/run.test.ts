import { describe, expect, it } from 'vitest'
import { testSource, testDestination } from '@stripe/stateless-sync'
import type { ConnectorResolver, StateMessage } from '@stripe/sync-engine-stateless-cli'
import { memoryCredentialStore, flagConfigStore } from '@stripe/stateful-sync'
import type { Credential } from '@stripe/stateful-sync'
import { runSync } from './run'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCred(id: string, type: string): Credential {
  return {
    id,
    type,
    fields: {},
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

    const configs = flagConfigStore({
      id: 'test_sync',
      source_credential_id: 'src-cred',
      destination_credential_id: 'dst-cred',
      source: { type: 'test', streams: { customers: {} } },
      destination: { type: 'test' },
    })

    const messages: StateMessage[] = []
    for await (const msg of runSync({
      syncId: 'test_sync',
      sourceType: 'test',
      destinationType: 'test',
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

    const configs = flagConfigStore({
      id: 'test_sync',
      source_credential_id: 'src-cred',
      destination_credential_id: 'dst-cred',
      source: {
        type: 'test',
        streams: { customers: {}, invoices: {} },
      },
      destination: { type: 'test' },
    })

    const messages: StateMessage[] = []
    for await (const msg of runSync({
      syncId: 'test_sync',
      sourceType: 'test',
      destinationType: 'test',
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
