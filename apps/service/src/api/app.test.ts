import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { ConnectorResolver } from '@stripe/sync-engine'
import { sourceTest, destinationTest } from '@stripe/sync-engine'
import { createApp } from './app.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resolver: ConnectorResolver = {
  resolveSource: async () => sourceTest,
  resolveDestination: async () => destinationTest,
}

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sync-service-test-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function app() {
  return createApp({ dataDir, connectors: resolver })
}

// ---------------------------------------------------------------------------
// OpenAPI spec
// ---------------------------------------------------------------------------

describe('GET /openapi.json', () => {
  it('returns a valid OpenAPI 3.0 spec', async () => {
    const res = await app().request('/openapi.json')
    expect(res.status).toBe(200)
    const spec = await res.json()
    expect(spec.openapi).toBe('3.0.0')
    expect(spec.info.title).toBeDefined()
    expect(spec.paths).toBeDefined()
  })

  it('includes credential, sync, and webhook paths', async () => {
    const res = await app().request('/openapi.json')
    const spec = (await res.json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(spec.paths)

    expect(paths).toContain('/credentials')
    expect(paths).toContain('/credentials/{id}')
    expect(paths).toContain('/syncs')
    expect(paths).toContain('/syncs/{id}')
    expect(paths).toContain('/syncs/{id}/run')
    expect(paths).toContain('/webhooks/{credential_id}')
  })

  it('tags operations for grouped CLI generation', async () => {
    const res = await app().request('/openapi.json')
    const spec = (await res.json()) as any
    const allTags = new Set<string>()
    for (const pathItem of Object.values(spec.paths) as any[]) {
      for (const op of Object.values(pathItem) as any[]) {
        if (op?.tags) op.tags.forEach((t: string) => allTags.add(t))
      }
    }
    expect(allTags).toContain('Credentials')
    expect(allTags).toContain('Syncs')
    expect(allTags).toContain('Sync Operations')
    expect(allTags).toContain('Webhooks')
  })
})

describe('GET /docs', () => {
  it('returns HTML (Scalar API reference)', async () => {
    const res = await app().request('/docs')
    expect(res.status).toBe(200)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType).toContain('text/html')
  })
})

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app().request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// Credentials CRUD
// ---------------------------------------------------------------------------

describe('credentials', () => {
  it('create → get → list → update → delete', async () => {
    const a = app()

    // Create
    const createRes = await a.request('/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'stripe', api_key: 'sk_test_123' }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as any
    expect(created.id).toMatch(/^cred_/)
    expect(created.type).toBe('stripe')
    expect(created.api_key).toBe('sk_test_123')
    expect(created.created_at).toBeDefined()

    const credId = created.id

    // Get
    const getRes = await a.request(`/credentials/${credId}`)
    expect(getRes.status).toBe(200)
    expect(((await getRes.json()) as any).api_key).toBe('sk_test_123')

    // List
    const listRes = await a.request('/credentials')
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as any
    expect(list.data).toHaveLength(1)
    expect(list.has_more).toBe(false)

    // Update
    const updateRes = await a.request(`/credentials/${credId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'sk_test_456' }),
    })
    expect(updateRes.status).toBe(200)
    const updated = (await updateRes.json()) as any
    expect(updated.api_key).toBe('sk_test_456')
    expect(updated.id).toBe(credId)

    // Delete
    const deleteRes = await a.request(`/credentials/${credId}`, {
      method: 'DELETE',
    })
    expect(deleteRes.status).toBe(200)
    expect(await deleteRes.json()).toEqual({ id: credId, deleted: true })

    // 404 after delete
    const missingRes = await a.request(`/credentials/${credId}`)
    expect(missingRes.status).toBe(404)
  })

  it('returns 404 for non-existent credential', async () => {
    const res = await app().request('/credentials/cred_nope')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Syncs CRUD
// ---------------------------------------------------------------------------

describe('syncs', () => {
  it('create → get → list → update → delete', async () => {
    const a = app()

    // Create sync (no credential refs)
    const createRes = await a.request('/syncs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test' },
        destination: { type: 'test' },
        streams: [{ name: 'customers' }],
      }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as any
    expect(created.id).toMatch(/^sync_/)
    expect(created.source.type).toBe('test')

    const syncId = created.id

    // Get
    const getRes = await a.request(`/syncs/${syncId}`)
    expect(getRes.status).toBe(200)

    // List
    const listRes = await a.request('/syncs')
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as any
    expect(list.data).toHaveLength(1)

    // Update
    const updateRes = await a.request(`/syncs/${syncId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        streams: [{ name: 'products' }],
      }),
    })
    expect(updateRes.status).toBe(200)
    const updated = (await updateRes.json()) as any
    expect(updated.streams[0].name).toBe('products')

    // Delete
    const deleteRes = await a.request(`/syncs/${syncId}`, {
      method: 'DELETE',
    })
    expect(deleteRes.status).toBe(200)
    expect(await deleteRes.json()).toEqual({ id: syncId, deleted: true })
  })

  it('returns 404 for non-existent sync', async () => {
    const res = await app().request('/syncs/sync_nope')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Referential integrity
// ---------------------------------------------------------------------------

describe('referential integrity', () => {
  it('rejects sync create with non-existent credential', async () => {
    const res = await app().request('/syncs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test', credential_id: 'cred_nope' },
        destination: { type: 'test' },
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error).toContain('cred_nope')
  })

  it('prevents deleting credential referenced by a sync', async () => {
    const a = app()

    // Create credential
    const credRes = await a.request('/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'stripe', api_key: 'sk_test_123' }),
    })
    const cred = (await credRes.json()) as any

    // Create sync referencing the credential
    await a.request('/syncs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test', credential_id: cred.id },
        destination: { type: 'test' },
      }),
    })

    // Try to delete credential → 409
    const deleteRes = await a.request(`/credentials/${cred.id}`, {
      method: 'DELETE',
    })
    expect(deleteRes.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------
// Webhook ingress
// ---------------------------------------------------------------------------

describe('POST /webhooks/:credential_id', () => {
  it('accepts webhook events and returns ok', async () => {
    const res = await app().request('/webhooks/cred_abc123', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})
