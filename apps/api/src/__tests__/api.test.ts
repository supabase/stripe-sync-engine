import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Fresh store dir for each test run
const tmpDir = mkdtempSync(join(tmpdir(), 'sync-api-test-'))
process.env.STORE_DIR = tmpDir

// Import app after setting STORE_DIR
const { app } = await import('../app')

// ── Helpers ─────────────────────────────────────────────────────

function post(path: string, body: any) {
  return app.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

function patch(path: string, body: any) {
  return app.request(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

function del(path: string) {
  return app.request(path, { method: 'DELETE' })
}

// ── Cleanup ─────────────────────────────────────────────────────

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── Credentials CRUD ────────────────────────────────────────────

describe('credentials', () => {
  let stripeCredId: string
  let pgCredId: string

  it('POST /credentials — create stripe credential', async () => {
    const res = await post('/credentials', {
      type: 'stripe',
      api_key: 'sk_test_123',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toMatch(/^cred_/)
    expect(body.account_id).toBe('acct_default')
    expect(body.type).toBe('stripe')
    expect(body.api_key).toBe('sk_test_123')
    stripeCredId = body.id
  })

  it('POST /credentials — create postgres credential', async () => {
    const res = await post('/credentials', {
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      user: 'sync',
      password: 'secret',
      database: 'mydb',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toMatch(/^cred_/)
    expect(body.type).toBe('postgres')
    expect(body.host).toBe('localhost')
    pgCredId = body.id
  })

  it('GET /credentials — list returns both', async () => {
    const res = await app.request('/credentials')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(2)
    expect(body.has_more).toBe(false)
  })

  it('GET /credentials/:id — retrieve by id', async () => {
    const res = await app.request(`/credentials/${stripeCredId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(stripeCredId)
    expect(body.type).toBe('stripe')
  })

  it('GET /credentials/:id — 404 for missing', async () => {
    const res = await app.request('/credentials/cred_nonexistent')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toContain('not found')
  })

  it('PATCH /credentials/:id — update fields', async () => {
    const res = await patch(`/credentials/${pgCredId}`, {
      password: 'new_secret',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(pgCredId)
    expect(body.password).toBe('new_secret')
    expect(body.host).toBe('localhost') // unchanged fields preserved
  })

  it('PATCH /credentials/:id — 404 for missing', async () => {
    const res = await patch('/credentials/cred_nonexistent', {
      password: 'x',
    })
    expect(res.status).toBe(404)
  })

  it('DELETE /credentials/:id — removes credential', async () => {
    const res = await del(`/credentials/${stripeCredId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(stripeCredId)
    expect(body.deleted).toBe(true)
  })

  it('DELETE /credentials/:id — 404 for already deleted', async () => {
    const res = await del(`/credentials/${stripeCredId}`)
    expect(res.status).toBe(404)
  })

  it('GET /credentials — list reflects deletion', async () => {
    const res = await app.request('/credentials')
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe(pgCredId)
  })
})

// ── Syncs CRUD ──────────────────────────────────────────────────

describe('syncs', () => {
  let syncId: string

  const syncBody = {
    account_id: 'acct_abc',
    status: 'backfilling',
    source: {
      type: 'stripe-api-core',
      livemode: true,
      api_version: '2025-04-30.basil',
      credential_id: 'cred_test',
    },
    destination: {
      type: 'postgres',
      schema_name: 'stripe',
      credential_id: 'cred_pg',
    },
  }

  it('POST /syncs — create sync', async () => {
    const res = await post('/syncs', syncBody)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toMatch(/^sync_/)
    expect(body.account_id).toBe('acct_abc')
    expect(body.status).toBe('backfilling')
    expect(body.source.type).toBe('stripe-api-core')
    expect(body.destination.type).toBe('postgres')
    syncId = body.id
  })

  it('GET /syncs — list returns created sync', async () => {
    const res = await app.request('/syncs')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe(syncId)
  })

  it('GET /syncs/:id — retrieve by id', async () => {
    const res = await app.request(`/syncs/${syncId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(syncId)
    expect(body.source.api_version).toBe('2025-04-30.basil')
  })

  it('GET /syncs/:id — 404 for missing', async () => {
    const res = await app.request('/syncs/sync_nonexistent')
    expect(res.status).toBe(404)
  })

  it('PATCH /syncs/:id — update status', async () => {
    const res = await patch(`/syncs/${syncId}`, { status: 'paused' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('paused')
    expect(body.source.type).toBe('stripe-api-core') // rest preserved
  })

  it('PATCH /syncs/:id — add streams', async () => {
    const res = await patch(`/syncs/${syncId}`, {
      streams: [
        { name: 'customers', sync_mode: 'incremental' },
        { name: 'invoices', skip_backfill: true },
      ],
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.streams).toHaveLength(2)
    expect(body.streams[0].name).toBe('customers')
    expect(body.streams[1].skip_backfill).toBe(true)
  })

  it('DELETE /syncs/:id — removes sync', async () => {
    const res = await del(`/syncs/${syncId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deleted).toBe(true)
  })

  it('GET /syncs — empty after delete', async () => {
    const res = await app.request('/syncs')
    const body = await res.json()
    expect(body.data).toHaveLength(0)
  })
})

// ── Persistence ─────────────────────────────────────────────────

describe('persistence', () => {
  it('credentials are written to disk as JSON', async () => {
    await post('/credentials', { type: 'stripe', api_key: 'sk_persist' })
    const file = join(tmpDir, 'credentials.json')
    expect(existsSync(file)).toBe(true)
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    const ids = Object.keys(data)
    expect(ids.length).toBeGreaterThan(0)
    const cred = data[ids[ids.length - 1]]
    expect(cred.api_key).toBe('sk_persist')
  })

  it('syncs are written to disk as JSON', async () => {
    await post('/syncs', {
      account_id: 'acct_persist',
      status: 'syncing',
      source: {
        type: 'stripe-api-core',
        livemode: false,
        api_version: '2025-04-30.basil',
        credential_id: 'cred_x',
      },
      destination: {
        type: 'stripe-database',
        database_id: 'db_persist',
      },
    })
    const file = join(tmpDir, 'syncs.json')
    expect(existsSync(file)).toBe(true)
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    const values = Object.values(data) as any[]
    const sync = values.find((s) => s.account_id === 'acct_persist')
    expect(sync).toBeDefined()
    expect(sync.destination.database_id).toBe('db_persist')
  })

  it('updates persist across reads', async () => {
    // Create, update, then re-read — should see updated value
    const createRes = await post('/credentials', {
      type: 'google',
      client_id: 'cid',
      client_secret: 'csec',
    })
    const { id } = await createRes.json()

    await patch(`/credentials/${id}`, { refresh_token: 'rt_new' })

    const getRes = await app.request(`/credentials/${id}`)
    const body = await getRes.json()
    expect(body.refresh_token).toBe('rt_new')
    expect(body.client_id).toBe('cid') // original field preserved
  })
})

// ── OpenAPI ─────────────────────────────────────────────────────

describe('openapi', () => {
  it('GET /openapi.json — returns valid spec', async () => {
    const res = await app.request('/openapi.json')
    expect(res.status).toBe(200)
    const spec = await res.json()
    expect(spec.openapi).toBe('3.0.0')
    expect(spec.info.title).toBe('Sync Service API')
    expect(spec.paths['/credentials']).toBeDefined()
    expect(spec.paths['/syncs']).toBeDefined()
    expect(spec.paths['/credentials/{id}']).toBeDefined()
    expect(spec.paths['/syncs/{id}']).toBeDefined()
  })

  it('GET /docs — returns swagger UI html', async () => {
    const res = await app.request('/docs')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('swagger')
  })
})
