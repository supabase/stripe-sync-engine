import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  Destination,
  DestinationInput,
  DestinationOutput,
  ConfiguredCatalog,
  Message,
  Source,
  StateMessage,
} from '@stripe/sync-engine-stateless'
import { createConnectorResolver } from '@stripe/sync-engine-stateless'
import { createApp } from './app'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Default mock sources for schema generation. */
const defaultMockSource = createMockSource([])
const defaultMockEventBridgeSource: Source = {
  ...defaultMockSource,
  spec: () => ({ config: {} }),
}

/** Default connectors for tests — defines valid type names for schemas. */
function defaultConnectors() {
  return createConnectorResolver({
    sources: {
      'stripe-api-core': defaultMockSource,
      'stripe-event-bridge': defaultMockEventBridgeSource,
    },
    destinations: { postgres: createMockDestination().destination },
  })
}

/** Connectors for engine operation tests that use custom source/destination. */
function connectors(source: Source, destination: Destination) {
  return createConnectorResolver({
    sources: { 'stripe-api-core': source, 'stripe-event-bridge': defaultMockEventBridgeSource },
    destinations: { postgres: destination },
  })
}

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item
  }
}

/** Read an NDJSON response body, returning all parsed objects. */
async function readNdjson(res: Response): Promise<unknown[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
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

// ── Helpers ──────────────────────────────────────────────────────

function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function patch(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function del(app: ReturnType<typeof createApp>, path: string) {
  return app.request(path, { method: 'DELETE' })
}

// ── Credentials CRUD ─────────────────────────────────────────────

describe('credentials CRUD', () => {
  it('creates and retrieves a source credential', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })

    const createRes = await post(app, '/credentials', {
      type: 'stripe-api-core',
      api_key: 'sk_test_123',
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json()
    expect(created.id).toMatch(/^cred_/)
    expect(created.type).toBe('stripe-api-core')
    expect(created.api_key).toBe('sk_test_123')
    expect(created.account_id).toBe('acct_default')

    const getRes = await app.request(`/credentials/${created.id}`)
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toEqual(created)
  })

  it('creates and retrieves a postgres credential', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })

    const createRes = await post(app, '/credentials', {
      type: 'postgres',
      connection_string: 'postgresql://sync:secret@localhost:5432/mydb',
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json()
    expect(created.id).toMatch(/^cred_/)
    expect(created.type).toBe('postgres')
    expect(created.connection_string).toBe('postgresql://sync:secret@localhost:5432/mydb')
  })

  it('lists credentials', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })

    const res1 = await post(app, '/credentials', {
      type: 'stripe-api-core',
      api_key: 'sk_test',
    })
    const { id: id1 } = await res1.json()

    const res2 = await post(app, '/credentials', {
      type: 'postgres',
      connection_string: 'postgresql://u:p@localhost:5432/db',
    })
    const { id: id2 } = await res2.json()

    const listRes = await app.request('/credentials')
    expect(listRes.status).toBe(200)
    const body = await listRes.json()
    expect(body.data).toHaveLength(2)
    expect(body.has_more).toBe(false)
    const ids = body.data.map((c: any) => c.id)
    expect(ids).toContain(id1)
    expect(ids).toContain(id2)
  })

  it('returns 404 for missing credential', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const res = await app.request('/credentials/cred_nonexistent')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBeDefined()
  })

  it('rejects credential with invalid type', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const res = await post(app, '/credentials', { type: 'unknown_type' })
    expect(res.status).toBe(400)
  })

  it('patches credential fields', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })

    const createRes = await post(app, '/credentials', {
      type: 'postgres',
      connection_string: 'postgresql://sync:old_secret@localhost:5432/mydb',
    })
    const { id } = await createRes.json()

    const patchRes = await patch(app, `/credentials/${id}`, {
      connection_string: 'postgresql://sync:new_secret@localhost:5432/mydb',
    })
    expect(patchRes.status).toBe(200)
    const patched = await patchRes.json()
    expect(patched.id).toBe(id)
    expect(patched.connection_string).toBe('postgresql://sync:new_secret@localhost:5432/mydb')

    // Re-fetch to confirm persistence
    const getRes = await app.request(`/credentials/${id}`)
    const fetched = await getRes.json()
    expect(fetched.connection_string).toBe('postgresql://sync:new_secret@localhost:5432/mydb')
  })

  it('returns 404 on patch for missing credential', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const res = await patch(app, '/credentials/cred_nonexistent', { api_key: 'x' })
    expect(res.status).toBe(404)
  })

  it('deletes a credential', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })

    const createRes = await post(app, '/credentials', {
      type: 'stripe-api-core',
      api_key: 'sk_test',
    })
    const { id } = await createRes.json()

    const delRes = await del(app, `/credentials/${id}`)
    expect(delRes.status).toBe(200)
    const delBody = await delRes.json()
    expect(delBody.id).toBe(id)
    expect(delBody.deleted).toBe(true)

    const getRes = await app.request(`/credentials/${id}`)
    expect(getRes.status).toBe(404)
  })

  it('returns 404 on delete for missing credential', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const res = await del(app, '/credentials/cred_nonexistent')
    expect(res.status).toBe(404)
  })
})

// ── Syncs CRUD ───────────────────────────────────────────────────

const baseSyncBody = {
  account_id: 'acct_abc',
  status: 'backfilling' as const,
  source: {
    type: 'stripe-api-core' as const,
    credential_id: '', // placeholder — replaced by seeded credential
  },
  destination: {
    type: 'postgres' as const,
    credential_id: '', // placeholder
  },
}

/** Also used by referential integrity tests. */
const validSyncBody = baseSyncBody

/** Create source + destination credentials and return a sync body with real IDs. */
async function seedCredentialsAndSyncBody(app: ReturnType<typeof createApp>) {
  const srcRes = await post(app, '/credentials', {
    type: 'stripe-api-core',
    api_key: 'sk_test',
  })
  const { id: srcCredId } = await srcRes.json()
  const dstRes = await post(app, '/credentials', {
    type: 'postgres',
    connection_string: 'postgresql://u:p@localhost:5432/db',
  })
  const { id: dstCredId } = await dstRes.json()
  return {
    srcCredId,
    dstCredId,
    body: {
      ...baseSyncBody,
      source: { ...baseSyncBody.source, credential_id: srcCredId },
      destination: { ...baseSyncBody.destination, credential_id: dstCredId },
    },
  }
}

describe('syncs CRUD', () => {
  it('creates and retrieves a sync', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const { body: syncBody, srcCredId, dstCredId } = await seedCredentialsAndSyncBody(app)

    const createRes = await post(app, '/syncs', syncBody)
    expect(createRes.status).toBe(201)
    const created = await createRes.json()
    expect(created.id).toMatch(/^sync_/)
    expect(created.account_id).toBe('acct_abc')
    expect(created.status).toBe('backfilling')
    expect(created.source.type).toBe('stripe-api-core')
    expect(created.source.credential_id).toBe(srcCredId)
    expect(created.destination.type).toBe('postgres')
    expect(created.destination.credential_id).toBe(dstCredId)

    const getRes = await app.request(`/syncs/${created.id}`)
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toEqual(created)
  })

  it('lists syncs', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const { body: syncBody } = await seedCredentialsAndSyncBody(app)

    const createRes = await post(app, '/syncs', syncBody)
    const { id } = await createRes.json()

    const listRes = await app.request('/syncs')
    expect(listRes.status).toBe(200)
    const body = await listRes.json()
    expect(body.data).toHaveLength(1)
    expect(body.has_more).toBe(false)
    expect(body.data[0].id).toBe(id)
  })

  it('returns 404 for missing sync', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const res = await app.request('/syncs/sync_nonexistent')
    expect(res.status).toBe(404)
  })

  it('rejects sync without required fields', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const res = await post(app, '/syncs', {})
    expect(res.status).toBe(400)
  })

  it('patches sync status', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const { body: syncBody } = await seedCredentialsAndSyncBody(app)

    const createRes = await post(app, '/syncs', syncBody)
    const { id } = await createRes.json()

    const patchRes = await patch(app, `/syncs/${id}`, { status: 'paused' })
    expect(patchRes.status).toBe(200)
    const patched = await patchRes.json()
    expect(patched.status).toBe('paused')
    expect(patched.source.type).toBe('stripe-api-core') // rest preserved
  })

  it('patches sync streams', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const { body: syncBody } = await seedCredentialsAndSyncBody(app)

    const createRes = await post(app, '/syncs', syncBody)
    const { id } = await createRes.json()

    const streams = [
      { name: 'customers', sync_mode: 'incremental' as const },
      { name: 'invoices', skip_backfill: true },
    ]
    const patchRes = await patch(app, `/syncs/${id}`, { streams })
    expect(patchRes.status).toBe(200)
    const patched = await patchRes.json()
    expect(patched.streams).toHaveLength(2)
    expect(patched.streams[0].name).toBe('customers')
    expect(patched.streams[1].skip_backfill).toBe(true)
  })

  it('returns 404 on patch for missing sync', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const res = await patch(app, '/syncs/sync_nonexistent', { status: 'paused' })
    expect(res.status).toBe(404)
  })

  it('deletes a sync', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const { body: syncBody } = await seedCredentialsAndSyncBody(app)

    const createRes = await post(app, '/syncs', syncBody)
    const { id } = await createRes.json()

    const delRes = await del(app, `/syncs/${id}`)
    expect(delRes.status).toBe(200)
    const delBody = await delRes.json()
    expect(delBody.id).toBe(id)
    expect(delBody.deleted).toBe(true)

    const getRes = await app.request(`/syncs/${id}`)
    expect(getRes.status).toBe(404)
  })

  it('returns 404 on delete for missing sync', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const res = await del(app, '/syncs/sync_nonexistent')
    expect(res.status).toBe(404)
  })
})

// ── Referential integrity ────────────────────────────────────────

describe('referential integrity', () => {
  it('rejects sync creation with nonexistent credential_id', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const res = await post(app, '/syncs', {
      ...validSyncBody,
      source: { ...validSyncBody.source, credential_id: 'cred_nonexistent' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('cred_nonexistent')
  })

  it('rejects sync update with nonexistent credential_id', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })

    // Create valid credentials and sync first
    const srcRes = await post(app, '/credentials', {
      type: 'stripe-api-core',
      api_key: 'sk_test',
    })
    const { id: srcCredId } = await srcRes.json()
    const dstRes = await post(app, '/credentials', {
      type: 'postgres',
      connection_string: 'postgresql://u:p@localhost:5432/db',
    })
    const { id: dstCredId } = await dstRes.json()

    const syncRes = await post(app, '/syncs', {
      ...validSyncBody,
      source: { ...validSyncBody.source, credential_id: srcCredId },
      destination: { ...validSyncBody.destination, credential_id: dstCredId },
    })
    const { id: syncId } = await syncRes.json()

    // Attempt to patch with nonexistent credential
    const patchRes = await patch(app, `/syncs/${syncId}`, {
      source: { ...validSyncBody.source, credential_id: 'cred_ghost' },
    })
    expect(patchRes.status).toBe(400)
    const body = await patchRes.json()
    expect(body.error).toContain('cred_ghost')
  })

  it('blocks credential deletion when referenced by a sync (409)', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })

    const srcRes = await post(app, '/credentials', {
      type: 'stripe-api-core',
      api_key: 'sk_test',
    })
    const { id: srcCredId } = await srcRes.json()
    const dstRes = await post(app, '/credentials', {
      type: 'postgres',
      connection_string: 'postgresql://u:p@localhost:5432/db',
    })
    const { id: dstCredId } = await dstRes.json()

    const syncRes = await post(app, '/syncs', {
      ...validSyncBody,
      source: { ...validSyncBody.source, credential_id: srcCredId },
      destination: { ...validSyncBody.destination, credential_id: dstCredId },
    })
    const { id: syncId } = await syncRes.json()

    // Cannot delete source credential
    const delRes = await del(app, `/credentials/${srcCredId}`)
    expect(delRes.status).toBe(409)
    const body = await delRes.json()
    expect(body.error).toContain(syncId)

    // Cannot delete destination credential either
    const delRes2 = await del(app, `/credentials/${dstCredId}`)
    expect(delRes2.status).toBe(409)
  })

  it('allows credential deletion after sync is removed', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })

    const srcRes = await post(app, '/credentials', {
      type: 'stripe-api-core',
      api_key: 'sk_test',
    })
    const { id: srcCredId } = await srcRes.json()
    const dstRes = await post(app, '/credentials', {
      type: 'postgres',
      connection_string: 'postgresql://u:p@localhost:5432/db',
    })
    const { id: dstCredId } = await dstRes.json()

    const syncRes = await post(app, '/syncs', {
      ...validSyncBody,
      source: { ...validSyncBody.source, credential_id: srcCredId },
      destination: { ...validSyncBody.destination, credential_id: dstCredId },
    })
    const { id: syncId } = await syncRes.json()

    // Delete the sync first
    await del(app, `/syncs/${syncId}`)

    // Now credential deletion should succeed
    const delRes = await del(app, `/credentials/${srcCredId}`)
    expect(delRes.status).toBe(200)
    expect((await delRes.json()).deleted).toBe(true)
  })

  it('allows multiple syncs sharing a credential', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })

    const srcRes = await post(app, '/credentials', {
      type: 'stripe-api-core',
      api_key: 'sk_test',
    })
    const { id: srcCredId } = await srcRes.json()
    const dstRes = await post(app, '/credentials', {
      type: 'postgres',
      connection_string: 'postgresql://u:p@localhost:5432/db',
    })
    const { id: dstCredId } = await dstRes.json()

    const syncBody = {
      ...validSyncBody,
      source: { ...validSyncBody.source, credential_id: srcCredId },
      destination: { ...validSyncBody.destination, credential_id: dstCredId },
    }

    const res1 = await post(app, '/syncs', syncBody)
    expect(res1.status).toBe(201)
    const res2 = await post(app, '/syncs', syncBody)
    expect(res2.status).toBe(201)

    // Both syncs exist
    const listRes = await app.request('/syncs')
    const { data } = await listRes.json()
    expect(data).toHaveLength(2)
  })

  it('allows event-bridge source with no credential_id', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })

    const dstRes = await post(app, '/credentials', {
      type: 'postgres',
      connection_string: 'postgresql://u:p@localhost:5432/db',
    })
    const { id: dstCredId } = await dstRes.json()

    const res = await post(app, '/syncs', {
      account_id: 'acct_test',
      status: 'backfilling',
      source: {
        type: 'stripe-event-bridge',
      },
      destination: {
        type: 'postgres',
        credential_id: dstCredId,
      },
    })
    expect(res.status).toBe(201)
    const created = await res.json()
    expect(created.source.type).toBe('stripe-event-bridge')
    expect(created.source.credential_id).toBeUndefined()
  })
})

// ── OpenAPI ──────────────────────────────────────────────────────

describe('openapi', () => {
  it('GET /openapi.json — returns valid spec with dynamic connector types', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const res = await app.request('/openapi.json')
    expect(res.status).toBe(200)
    const spec = await res.json()
    expect(spec.openapi).toBe('3.0.0')
    expect(spec.info.title).toBe('Stripe Sync Stateful API')
    expect(spec.paths['/credentials']).toBeDefined()
    expect(spec.paths['/syncs']).toBeDefined()
    expect(spec.paths['/credentials/{id}']).toBeDefined()
    expect(spec.paths['/syncs/{id}']).toBeDefined()
  })

  it('GET /docs — returns swagger UI html', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const res = await app.request('/docs')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html.toLowerCase()).toContain('swagger')
  })
})

// ── Sync engine operation helpers ────────────────────────────────

/** Seed credentials and a sync config, return syncId. */
async function seedSync(
  app: ReturnType<typeof createApp>,
  source: Source,
  destination: Destination
): Promise<string> {
  const srcRes = await post(app, '/credentials', {
    type: 'stripe-api-core',
    api_key: 'sk_test',
  })
  const { id: srcCredId } = await srcRes.json()

  const dstRes = await post(app, '/credentials', {
    type: 'postgres',
    connection_string: 'postgresql://u:p@localhost:5432/db',
  })
  const { id: dstCredId } = await dstRes.json()

  const syncRes = await post(app, '/syncs', {
    account_id: 'acct_test',
    status: 'backfilling',
    source: {
      type: 'stripe-api-core',
      credential_id: srcCredId,
    },
    destination: {
      type: 'postgres',
      credential_id: dstCredId,
    },
  })
  const { id: syncId } = await syncRes.json()
  return syncId
}

// ── POST /syncs/:id/run ───────────────────────────────────────────

describe('POST /syncs/:id/run', () => {
  it('streams NDJSON state messages for a successful sync', async () => {
    const stateMsg: StateMessage = { type: 'state', stream: 'customers', data: { cursor: 'cus_1' } }
    const record: Message = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_1', name: 'Alice' },
      emitted_at: 1000,
    }
    const source = createMockSource([record, stateMsg])
    const { destination } = createMockDestination()
    const app = createApp({ dataDir, connectors: connectors(source, destination) })
    const syncId = await seedSync(app, source, destination)

    const res = await app.request(`/syncs/${syncId}/run`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/x-ndjson')

    const lines = await readNdjson(res)
    const stateMsgs = lines.filter((l: any) => l.type === 'state')
    expect(stateMsgs.length).toBeGreaterThanOrEqual(1)
  })

  it('streams NDJSON error when config is missing', async () => {
    const source = createMockSource([])
    const { destination } = createMockDestination()
    const app = createApp({ dataDir, connectors: connectors(source, destination) })

    const res = await app.request('/syncs/nonexistent/run', { method: 'POST' })
    expect(res.status).toBe(200) // streaming always starts 200

    const lines = await readNdjson(res)
    const errorLines = lines.filter((l: any) => l.type === 'error')
    expect(errorLines).toHaveLength(1)
  })
})

// ── /syncs/:id/setup + teardown ──────────────────────────────────

describe('POST /syncs/:id/setup and teardown', () => {
  it('setup returns 204', async () => {
    const source = createMockSource([])
    const { destination } = createMockDestination()
    const app = createApp({ dataDir, connectors: connectors(source, destination) })
    const syncId = await seedSync(app, source, destination)

    const res = await app.request(`/syncs/${syncId}/setup`, { method: 'POST' })
    expect(res.status).toBe(204)
  })

  it('teardown returns 204', async () => {
    const source = createMockSource([])
    const { destination } = createMockDestination()
    const app = createApp({ dataDir, connectors: connectors(source, destination) })
    const syncId = await seedSync(app, source, destination)

    const res = await app.request(`/syncs/${syncId}/teardown`, { method: 'POST' })
    expect(res.status).toBe(204)
  })
})

// ── GET /syncs/:id/check ─────────────────────────────────────────

describe('GET /syncs/:id/check', () => {
  it('returns check result JSON', async () => {
    const source = createMockSource([])
    const { destination } = createMockDestination()
    const app = createApp({ dataDir, connectors: connectors(source, destination) })
    const syncId = await seedSync(app, source, destination)

    const res = await app.request(`/syncs/${syncId}/check`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toBeDefined()
    expect(body.destination).toBeDefined()
    expect(body.source.status).toBe('succeeded')
    expect(body.destination.status).toBe('succeeded')
  })
})

// ── POST /syncs/:id/read ─────────────────────────────────────────

describe('POST /syncs/:id/read', () => {
  it('streams NDJSON messages from source', async () => {
    const record: Message = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_1' },
      emitted_at: 1000,
    }
    const stateMsg: StateMessage = { type: 'state', stream: 'customers', data: { cursor: 'c1' } }
    const source = createMockSource([record, stateMsg])
    const { destination } = createMockDestination()
    const app = createApp({ dataDir, connectors: connectors(source, destination) })
    const syncId = await seedSync(app, source, destination)

    const res = await app.request(`/syncs/${syncId}/read`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/x-ndjson')

    const lines = await readNdjson(res)
    expect(lines.length).toBeGreaterThanOrEqual(1)
  })
})

// ── POST /webhooks/:credential_id ───────────────────────────────

/** Yield to the macro-task queue so all pending async generator steps can settle. */
function nextTick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('POST /webhooks/:credential_id', () => {
  it('returns 200 ok for any credential_id regardless of running syncs', async () => {
    const app = createApp({ dataDir, connectors: defaultConnectors() })
    const res = await app.request('/webhooks/cred_any', {
      method: 'POST',
      headers: { 'stripe-signature': 't=123,v1=abc' },
      body: 'raw body',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('delivers { body, headers } to a running sync registered under that credential', async () => {
    let capturedInput: unknown

    // A source that captures the first $stdin item then terminates.
    // Yields one state message so run() produces output and closes the stream.
    const capturingSource: Source = {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' as const }),
      discover: async () => ({
        type: 'catalog' as const,
        streams: [{ name: 'customers', primary_key: [['id']] }],
      }),
      async *read(_params, $stdin) {
        if (!$stdin) return
        for await (const input of $stdin) {
          capturedInput = input
          yield { type: 'state' as const, stream: 'customers', data: {} }
          return // terminate after one event
        }
      },
      setup: async () => {},
      teardown: async () => {},
    }

    const { destination } = createMockDestination()
    const app = createApp({ dataDir, connectors: connectors(capturingSource, destination) })

    const { srcCredId, body: syncBody } = await seedCredentialsAndSyncBody(app)
    const syncRes = await post(app, '/syncs', syncBody)
    const { id: syncId } = await syncRes.json()

    // Start the run — ReadableStream.start fires immediately, source blocks on $stdin.next().
    const runRes = await app.request(`/syncs/${syncId}/run`, { method: 'POST' })

    // One macro-tick lets all in-memory async steps in the generator settle
    // (configs.get, resolveSource, credentials.get, engine.setup, etc.) so that
    // the internal queue is registered and source.read() is waiting on $stdin.
    await nextTick()

    // POST the webhook — the route forwards raw { body, headers } without any
    // Stripe-specific knowledge.
    const webhookBody = '{"id":"evt_test_123","type":"customer.created"}'
    const webhookSig = 't=1234567890,v1=abc123'
    await app.request(`/webhooks/${srcCredId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'stripe-signature': webhookSig },
      body: webhookBody,
    })

    // Read the run response — completes once the source terminates after one event.
    const lines = await readNdjson(runRes)
    expect(lines.some((l: any) => l.type === 'state')).toBe(true)

    // The source received { body, headers } — source-agnostic envelope.
    // Source-stripe extracts 'stripe-signature' from headers internally.
    expect(capturedInput).toMatchObject({
      body: webhookBody,
      headers: expect.objectContaining({ 'stripe-signature': webhookSig }),
    })
  })
})

// ── POST /syncs/:id/write ────────────────────────────────────────

describe('POST /syncs/:id/write', () => {
  it('streams NDJSON state messages after writing', async () => {
    const source = createMockSource([])
    const { destination } = createMockDestination()
    const app = createApp({ dataDir, connectors: connectors(source, destination) })
    const syncId = await seedSync(app, source, destination)

    const body =
      JSON.stringify({ type: 'record', stream: 'customers', data: { id: 'c1' }, emitted_at: 0 }) +
      '\n' +
      JSON.stringify({ type: 'state', stream: 'customers', data: { cursor: 'x' } }) +
      '\n'

    const res = await app.request(`/syncs/${syncId}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/x-ndjson')

    const lines = await readNdjson(res)
    const stateMsgs = lines.filter((l: any) => l.type === 'state')
    expect(stateMsgs).toHaveLength(1)
  })

  it('returns 400 when body is missing', async () => {
    const source = createMockSource([])
    const { destination } = createMockDestination()
    const app = createApp({ dataDir, connectors: connectors(source, destination) })
    const syncId = await seedSync(app, source, destination)

    const res = await app.request(`/syncs/${syncId}/write`, { method: 'POST' })
    expect(res.status).toBe(400)
  })
})
