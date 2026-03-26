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

  it('includes pipeline and webhook paths', async () => {
    const res = await app().request('/openapi.json')
    const spec = (await res.json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(spec.paths)

    expect(paths).toContain('/pipelines')
    expect(paths).toContain('/pipelines/{id}')
    expect(paths).toContain('/pipelines/{id}/sync')
    expect(paths).toContain('/webhooks/{pipeline_id}')
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
    expect(allTags).toContain('Pipelines')
    expect(allTags).toContain('Pipeline Operations')
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
// Pipelines CRUD
// ---------------------------------------------------------------------------

describe('pipelines', () => {
  it('create → get → list → update → delete', async () => {
    const a = app()

    // Create pipeline (inline source/destination config)
    const createRes = await a.request('/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test', api_key: 'sk_test_123' },
        destination: { type: 'test', connection_string: 'postgres://localhost/db' },
        streams: [{ name: 'customers' }],
      }),
    })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as any
    expect(created.id).toMatch(/^pipe_/)
    expect(created.source.type).toBe('test')
    expect(created.source.api_key).toBe('sk_test_123')

    const pipelineId = created.id

    // Get
    const getRes = await a.request(`/pipelines/${pipelineId}`)
    expect(getRes.status).toBe(200)

    // List
    const listRes = await a.request('/pipelines')
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as any
    expect(list.data).toHaveLength(1)
    expect(list.has_more).toBe(false)

    // Update
    const updateRes = await a.request(`/pipelines/${pipelineId}`, {
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
    const deleteRes = await a.request(`/pipelines/${pipelineId}`, {
      method: 'DELETE',
    })
    expect(deleteRes.status).toBe(200)
    expect(await deleteRes.json()).toEqual({ id: pipelineId, deleted: true })
  })

  it('returns 404 for non-existent pipeline', async () => {
    const res = await app().request('/pipelines/pipe_nope')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Webhook ingress
// ---------------------------------------------------------------------------

describe('POST /webhooks/:pipeline_id', () => {
  it('accepts webhook events and returns ok', async () => {
    const res = await app().request('/webhooks/pipe_abc123', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})
