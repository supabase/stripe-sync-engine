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
      source: {
        type: 'test',
        streams: { customers: { records: [{ id: 'cus_1', name: 'Alice' }] } },
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
        streams: {
          customers: { records: [{ id: 'cus_1' }] },
          invoices: { records: [{ id: 'inv_1' }] },
        },
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
    })) {
      messages.push(msg)
    }

    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.stream).sort()).toEqual(['customers', 'invoices'])
  })
})
