import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  ConnectorResolver,
  Destination,
  DestinationInput,
  DestinationOutput,
  ConfiguredCatalog,
  Message,
  Source,
  StateMessage,
} from '@stripe/sync-protocol'
import { createApp } from '../app'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResolver(source: Source, destination: Destination): ConnectorResolver {
  return {
    resolveSource: async () => source,
    resolveDestination: async () => destination,
  }
}

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item
  }
}

/** Read an SSE response body, returning parsed data payloads keyed by event name. */
async function readSseEvents(res: Response): Promise<Array<{ event?: string; data: unknown }>> {
  const text = await res.text()
  const events: Array<{ event?: string; data: unknown }> = []
  let currentEvent: string | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim()
    } else if (line.startsWith('data: ')) {
      events.push({ event: currentEvent, data: JSON.parse(line.slice(6)) })
      currentEvent = undefined
    }
  }
  return events
}

function createMockSource(messages: Message[]): Source {
  return {
    spec: () => ({ config: {} }),
    check: async () => ({ status: 'succeeded' as const }),
    discover: async () => ({
      type: 'catalog',
      streams: [{ name: 'customers', primary_key: [['id']] }],
    }),
    read: () => toAsync(messages),
    setup: async () => {},
    teardown: async () => {},
  }
}

function createMockDestination(): { destination: Destination; received: DestinationInput[] } {
  const received: DestinationInput[] = []
  return {
    destination: {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' as const }),
      write: (
        _params: { config: Record<string, unknown>; catalog: ConfiguredCatalog },
        $stdin: AsyncIterable<DestinationInput>
      ): AsyncIterable<DestinationOutput> =>
        (async function* () {
          for await (const msg of $stdin) {
            received.push(msg)
            if (msg.type === 'state') yield msg
          }
        })(),
      setup: async () => {},
      teardown: async () => {},
    },
    received,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'stateful-api-test-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('credentials CRUD', () => {
  it('creates and retrieves a credential', async () => {
    const app = createApp({ dataDir })
    const cred = { id: 'cred_1', fields: { api_key: 'sk_test' } }

    const createRes = await app.request('/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cred),
    })
    expect(createRes.status).toBe(201)

    const getRes = await app.request('/credentials/cred_1')
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toEqual(cred)
  })

  it('lists credentials', async () => {
    const app = createApp({ dataDir })
    const cred = { id: 'cred_1', fields: { api_key: 'sk_test' } }

    await app.request('/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cred),
    })

    const res = await app.request('/credentials')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe('cred_1')
  })

  it('returns 404 for missing credential', async () => {
    const app = createApp({ dataDir })
    const res = await app.request('/credentials/nonexistent')
    expect(res.status).toBe(404)
  })

  it('rejects credential without id', async () => {
    const app = createApp({ dataDir })
    const res = await app.request('/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {} }),
    })
    expect(res.status).toBe(400)
  })

  it('deletes a credential', async () => {
    const app = createApp({ dataDir })
    await app.request('/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'cred_1', fields: {} }),
    })

    const delRes = await app.request('/credentials/cred_1', { method: 'DELETE' })
    expect(delRes.status).toBe(200)

    const getRes = await app.request('/credentials/cred_1')
    expect(getRes.status).toBe(404)
  })
})

describe('syncs CRUD', () => {
  it('creates and retrieves a sync', async () => {
    const app = createApp({ dataDir })
    const sync = {
      id: 'sync_1',
      source_credential_id: 'cred_src',
      destination_credential_id: 'cred_dst',
      source: { type: 'stripe' },
      destination: { type: 'postgres' },
    }

    const createRes = await app.request('/syncs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sync),
    })
    expect(createRes.status).toBe(201)

    const getRes = await app.request('/syncs/sync_1')
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toEqual(sync)
  })

  it('lists syncs', async () => {
    const app = createApp({ dataDir })
    const sync = {
      id: 'sync_1',
      source_credential_id: 'cred_src',
      destination_credential_id: 'cred_dst',
      source: { type: 'stripe' },
      destination: { type: 'postgres' },
    }

    await app.request('/syncs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sync),
    })

    const res = await app.request('/syncs')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
  })

  it('returns 404 for missing sync', async () => {
    const app = createApp({ dataDir })
    const res = await app.request('/syncs/nonexistent')
    expect(res.status).toBe(404)
  })

  it('rejects sync without id', async () => {
    const app = createApp({ dataDir })
    const res = await app.request('/syncs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { type: 'stripe' }, destination: { type: 'postgres' } }),
    })
    expect(res.status).toBe(400)
  })

  it('deletes a sync', async () => {
    const app = createApp({ dataDir })
    await app.request('/syncs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'sync_1',
        source_credential_id: 'c',
        destination_credential_id: 'd',
        source: { type: 'stripe' },
        destination: { type: 'postgres' },
      }),
    })

    const delRes = await app.request('/syncs/sync_1', { method: 'DELETE' })
    expect(delRes.status).toBe(200)

    const getRes = await app.request('/syncs/sync_1')
    expect(getRes.status).toBe(404)
  })
})

describe('POST /syncs/:id/run', () => {
  it('streams SSE state messages for a successful sync', async () => {
    const stateMsg: StateMessage = { type: 'state', stream: 'customers', data: { cursor: 'cus_1' } }
    const record: Message = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_1', name: 'Alice' },
      emitted_at: 1000,
    }
    const source = createMockSource([record, stateMsg])
    const { destination } = createMockDestination()

    const app = createApp({ dataDir, connectors: mockResolver(source, destination) })

    // Seed credentials + sync config
    await app.request('/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'src_cred', fields: { api_key: 'sk_test' } }),
    })
    await app.request('/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'dst_cred', fields: { url: 'pg://localhost/test' } }),
    })
    await app.request('/syncs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'test_sync',
        source_credential_id: 'src_cred',
        destination_credential_id: 'dst_cred',
        source: { type: 'stripe' },
        destination: { type: 'postgres' },
      }),
    })

    const res = await app.request('/syncs/test_sync/run', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/event-stream')

    const events = await readSseEvents(res)
    const stateEvents = events.filter((e) => e.event === 'state')
    const doneEvents = events.filter((e) => e.event === 'done')
    expect(stateEvents.length).toBeGreaterThanOrEqual(1)
    expect(doneEvents).toHaveLength(1)
  })

  it('streams SSE error when config is missing', async () => {
    const source = createMockSource([])
    const { destination } = createMockDestination()
    const app = createApp({ dataDir, connectors: mockResolver(source, destination) })

    const res = await app.request('/syncs/nonexistent/run', { method: 'POST' })
    expect(res.status).toBe(200) // SSE always starts 200

    const events = await readSseEvents(res)
    const errorEvents = events.filter((e) => e.event === 'error')
    expect(errorEvents).toHaveLength(1)
  })
})
