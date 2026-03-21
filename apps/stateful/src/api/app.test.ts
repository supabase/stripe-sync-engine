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

function connectors(source: Source, destination: Destination) {
  return createConnectorResolver({
    sources: { 'stripe-api-core': source },
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
  it('creates and retrieves a stripe credential', async () => {
    const app = createApp({ dataDir })

    const createRes = await post(app, '/credentials', { type: 'stripe', api_key: 'sk_test_123' })
    expect(createRes.status).toBe(201)
    const created = await createRes.json()
    expect(created.id).toMatch(/^cred_/)
    expect(created.type).toBe('stripe')
    expect(created.api_key).toBe('sk_test_123')
    expect(created.account_id).toBe('acct_default')

    const getRes = await app.request(`/credentials/${created.id}`)
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toEqual(created)
  })

  it('creates and retrieves a postgres credential', async () => {
    const app = createApp({ dataDir })

    const createRes = await post(app, '/credentials', {
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      user: 'sync',
      password: 'secret',
      database: 'mydb',
    })
    expect(createRes.status).toBe(201)
    const created = await createRes.json()
    expect(created.id).toMatch(/^cred_/)
    expect(created.type).toBe('postgres')
    expect(created.host).toBe('localhost')
  })

  it('lists credentials', async () => {
    const app = createApp({ dataDir })

    const res1 = await post(app, '/credentials', { type: 'stripe', api_key: 'sk_test' })
    const { id: id1 } = await res1.json()

    const res2 = await post(app, '/credentials', {
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      user: 'u',
      password: 'p',
      database: 'db',
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
    const app = createApp({ dataDir })
    const res = await app.request('/credentials/cred_nonexistent')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBeDefined()
  })

  it('rejects credential with invalid type', async () => {
    const app = createApp({ dataDir })
    const res = await post(app, '/credentials', { type: 'unknown_type' })
    expect(res.status).toBe(400)
  })

  it('patches credential fields', async () => {
    const app = createApp({ dataDir })

    const createRes = await post(app, '/credentials', {
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      user: 'sync',
      password: 'old_secret',
      database: 'mydb',
    })
    const { id } = await createRes.json()

    const patchRes = await patch(app, `/credentials/${id}`, { password: 'new_secret' })
    expect(patchRes.status).toBe(200)
    const patched = await patchRes.json()
    expect(patched.id).toBe(id)
    expect(patched.password).toBe('new_secret')
    expect(patched.host).toBe('localhost') // unchanged fields preserved

    // Re-fetch to confirm persistence
    const getRes = await app.request(`/credentials/${id}`)
    const fetched = await getRes.json()
    expect(fetched.password).toBe('new_secret')
    expect(fetched.host).toBe('localhost')
  })

  it('returns 404 on patch for missing credential', async () => {
    const app = createApp({ dataDir })
    const res = await patch(app, '/credentials/cred_nonexistent', { api_key: 'x' })
    expect(res.status).toBe(404)
  })

  it('deletes a credential', async () => {
    const app = createApp({ dataDir })

    const createRes = await post(app, '/credentials', { type: 'stripe', api_key: 'sk_test' })
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
    const app = createApp({ dataDir })
    const res = await del(app, '/credentials/cred_nonexistent')
    expect(res.status).toBe(404)
  })
})

// ── Syncs CRUD ───────────────────────────────────────────────────

const validSyncBody = {
  account_id: 'acct_abc',
  status: 'backfilling' as const,
  source: {
    type: 'stripe-api-core' as const,
    livemode: true,
    api_version: '2025-04-30.basil' as const,
    credential_id: 'cred_src',
  },
  destination: {
    type: 'postgres' as const,
    schema_name: 'stripe',
    credential_id: 'cred_dst',
  },
}

describe('syncs CRUD', () => {
  it('creates and retrieves a sync', async () => {
    const app = createApp({ dataDir })

    const createRes = await post(app, '/syncs', validSyncBody)
    expect(createRes.status).toBe(201)
    const created = await createRes.json()
    expect(created.id).toMatch(/^sync_/)
    expect(created.account_id).toBe('acct_abc')
    expect(created.status).toBe('backfilling')
    expect(created.source.type).toBe('stripe-api-core')
    expect(created.source.credential_id).toBe('cred_src')
    expect(created.destination.type).toBe('postgres')
    expect(created.destination.credential_id).toBe('cred_dst')

    const getRes = await app.request(`/syncs/${created.id}`)
    expect(getRes.status).toBe(200)
    expect(await getRes.json()).toEqual(created)
  })

  it('lists syncs', async () => {
    const app = createApp({ dataDir })

    const createRes = await post(app, '/syncs', validSyncBody)
    const { id } = await createRes.json()

    const listRes = await app.request('/syncs')
    expect(listRes.status).toBe(200)
    const body = await listRes.json()
    expect(body.data).toHaveLength(1)
    expect(body.has_more).toBe(false)
    expect(body.data[0].id).toBe(id)
  })

  it('returns 404 for missing sync', async () => {
    const app = createApp({ dataDir })
    const res = await app.request('/syncs/sync_nonexistent')
    expect(res.status).toBe(404)
  })

  it('rejects sync without required fields', async () => {
    const app = createApp({ dataDir })
    const res = await post(app, '/syncs', {})
    expect(res.status).toBe(400)
  })

  it('patches sync status', async () => {
    const app = createApp({ dataDir })

    const createRes = await post(app, '/syncs', validSyncBody)
    const { id } = await createRes.json()

    const patchRes = await patch(app, `/syncs/${id}`, { status: 'paused' })
    expect(patchRes.status).toBe(200)
    const patched = await patchRes.json()
    expect(patched.status).toBe('paused')
    expect(patched.source.type).toBe('stripe-api-core') // rest preserved
  })

  it('patches sync streams', async () => {
    const app = createApp({ dataDir })

    const createRes = await post(app, '/syncs', validSyncBody)
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
    const app = createApp({ dataDir })
    const res = await patch(app, '/syncs/sync_nonexistent', { status: 'paused' })
    expect(res.status).toBe(404)
  })

  it('deletes a sync', async () => {
    const app = createApp({ dataDir })

    const createRes = await post(app, '/syncs', validSyncBody)
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
    const app = createApp({ dataDir })
    const res = await del(app, '/syncs/sync_nonexistent')
    expect(res.status).toBe(404)
  })
})

// ── OpenAPI ──────────────────────────────────────────────────────

describe('openapi', () => {
  it('GET /openapi.json — returns valid spec', async () => {
    const app = createApp({ dataDir })
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
    const app = createApp({ dataDir })
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
  const srcRes = await post(app, '/credentials', { type: 'stripe', api_key: 'sk_test' })
  const { id: srcCredId } = await srcRes.json()

  const dstRes = await post(app, '/credentials', {
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    user: 'u',
    password: 'p',
    database: 'db',
  })
  const { id: dstCredId } = await dstRes.json()

  const syncRes = await post(app, '/syncs', {
    account_id: 'acct_test',
    status: 'backfilling',
    source: {
      type: 'stripe-api-core',
      livemode: true,
      api_version: '2025-04-30.basil',
      credential_id: srcCredId,
    },
    destination: {
      type: 'postgres',
      schema_name: 'stripe',
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
