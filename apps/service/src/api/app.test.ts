import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import type { WorkflowClient } from '@temporalio/client'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import path from 'node:path'
import { createConnectorResolver, sourceTest, destinationTest } from '@stripe/sync-engine'
import destinationGoogleSheets from '@stripe/sync-destination-google-sheets'
import type { SyncActivities, RunResult } from '../temporal/activities/index.js'
import { createApp } from './app.js'

const resolver = createConnectorResolver({
  sources: { test: sourceTest },
  destinations: { test: destinationTest, 'google-sheets': destinationGoogleSheets },
})

// Lightweight app for spec/health tests (no Temporal needed)
function app() {
  return createApp({
    temporal: { client: {} as WorkflowClient, taskQueue: 'unused' },
    resolver,
  })
}

// ---------------------------------------------------------------------------
// OpenAPI spec
// ---------------------------------------------------------------------------

describe('GET /openapi.json', () => {
  it('returns a valid OpenAPI 3.0 spec', async () => {
    const res = await app().request('/openapi.json')
    expect(res.status).toBe(200)
    const spec = await res.json()
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.title).toBeDefined()
    expect(spec.paths).toBeDefined()
  })

  it('includes pipeline, pause/resume, and webhook paths', async () => {
    const res = await app().request('/openapi.json')
    const spec = (await res.json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(spec.paths)

    expect(paths).toContain('/pipelines')
    expect(paths).toContain('/pipelines/{id}')
    expect(paths).toContain('/pipelines/{id}/pause')
    expect(paths).toContain('/pipelines/{id}/resume')
    expect(paths).toContain('/webhooks/{pipeline_id}')
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

describe('POST /pipelines workflow dispatch', () => {
  it('starts google-sheets pipelines on the dedicated workflow', async () => {
    const start = vi.fn(async () => ({}))
    const res = await createApp({
      temporal: { client: { start } as unknown as WorkflowClient, taskQueue: 'unused' },
      resolver,
    }).request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test' },
        destination: {
          type: 'google-sheets',
          spreadsheet_id: 'sheet_123',
          spreadsheet_title: 'Test Sheet',
          client_id: 'client',
          client_secret: 'secret',
          access_token: 'token',
          refresh_token: 'refresh',
        },
      }),
    })

    expect(res.status).toBe(201)
    expect(start).toHaveBeenCalledOnce()
    expect(start).toHaveBeenCalledWith(
      'pipelineGoogleSheetsWorkflow',
      expect.objectContaining({
        taskQueue: 'unused',
      })
    )
  })
})

// ---------------------------------------------------------------------------
// Pipeline CRUD + pause/resume (in-memory Temporal, stub activities)
// ---------------------------------------------------------------------------

const workflowsPath = path.resolve(process.cwd(), 'dist/temporal/workflows')
const noErrors: RunResult = { errors: [], state: {} }

function stubActivities(): SyncActivities {
  return {
    discoverCatalog: async () => ({ streams: [] }),
    setup: async () => ({}),
    syncImmediate: async () => noErrors,
    readIntoQueueWithState: async () => ({ count: 0, state: {} }),
    readIntoQueue: async () => ({ count: 0, state: {} }),
    writeGoogleSheetsFromQueue: async () => ({
      errors: [],
      state: {},
      written: 0,
      rowAssignments: {},
    }),
    writeFromQueue: async () => ({ errors: [], state: {}, written: 0 }),
    teardown: async () => {},
  }
}

let testEnv: TestWorkflowEnvironment
let worker: Worker
let workerRunning: Promise<void>

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createLocal()
  worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: 'test-api',
    workflowsPath,
    activities: stubActivities(),
  })
  workerRunning = worker.run()
}, 120_000)

afterAll(async () => {
  worker?.shutdown()
  await workerRunning
  await testEnv?.teardown()
})

function liveApp() {
  return createApp({
    temporal: { client: testEnv.client.workflow, taskQueue: 'test-api' },
    resolver,
  })
}

/** Poll GET /pipelines/:id until the workflow is queryable (not 404). */
async function waitForPipeline(a: ReturnType<typeof liveApp>, id: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await a.request(`/pipelines/${id}`)
    if (res.status === 200) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Pipeline ${id} not queryable after ${timeoutMs}ms`)
}

describe('pipeline CRUD', () => {
  it('create returns full pipeline', async () => {
    const res = await liveApp().request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test' },
        destination: { type: 'test' },
        streams: [{ name: 'customers' }],
      }),
    })
    expect(res.status).toBe(201)
    const pipeline = await res.json()
    expect(pipeline.id).toMatch(/^pipe_/)
    expect(pipeline.source.type).toBe('test')
    expect(pipeline.destination.type).toBe('test')
  })

  it('update returns updated pipeline with status', async () => {
    const a = liveApp()

    // Create
    const createRes = await a.request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test' },
        destination: { type: 'test' },
        streams: [{ name: 'customers' }],
      }),
    })
    const created = await createRes.json()
    await waitForPipeline(a, created.id)

    // Update
    const updateRes = await a.request(`/pipelines/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streams: [{ name: 'products' }] }),
    })
    expect(updateRes.status).toBe(200)
    const updated = await updateRes.json()
    expect(updated.id).toBe(created.id)
    expect(updated.source.type).toBe('test')
    expect(updated.status).toBeDefined()
    expect(updated.status.paused).toBe(false)

    // Cleanup
    await a.request(`/pipelines/${created.id}`, { method: 'DELETE' })
  })

  it('rejects changing the target spreadsheet for a google-sheets pipeline', async () => {
    const a = liveApp()

    const createRes = await a.request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test' },
        destination: {
          type: 'google-sheets',
          spreadsheet_id: 'sheet_123',
          spreadsheet_title: 'Original Sheet',
          client_id: 'client',
          client_secret: 'secret',
          access_token: 'token',
          refresh_token: 'refresh',
        },
      }),
    })
    const created = await createRes.json()
    await waitForPipeline(a, created.id)

    const updateRes = await a.request(`/pipelines/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        destination: {
          type: 'google-sheets',
          spreadsheet_id: 'sheet_456',
          spreadsheet_title: 'Replacement Sheet',
          client_id: 'client',
          client_secret: 'secret',
          access_token: 'token',
          refresh_token: 'refresh',
        },
      }),
    })

    expect(updateRes.status).toBe(400)
    expect(await updateRes.json()).toEqual({
      error:
        'Changing the target spreadsheet for a google-sheets pipeline requires recreating the pipeline',
    })

    await a.request(`/pipelines/${created.id}`, { method: 'DELETE' })
  })

  it('allows changing spreadsheet title when spreadsheet_id is unchanged', async () => {
    const a = liveApp()

    const createRes = await a.request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test' },
        destination: {
          type: 'google-sheets',
          spreadsheet_id: 'sheet_123',
          spreadsheet_title: 'Original Sheet',
          client_id: 'client',
          client_secret: 'secret',
          access_token: 'token',
          refresh_token: 'refresh',
        },
      }),
    })
    const created = await createRes.json()
    await waitForPipeline(a, created.id)

    const updateRes = await a.request(`/pipelines/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        destination: {
          type: 'google-sheets',
          spreadsheet_id: 'sheet_123',
          spreadsheet_title: 'Renamed Sheet',
          client_id: 'client',
          client_secret: 'secret',
          access_token: 'token',
          refresh_token: 'refresh',
        },
      }),
    })

    expect(updateRes.status).toBe(200)
    const updated = await updateRes.json()
    expect(updated.destination.spreadsheet_id).toBe('sheet_123')
    expect(updated.destination.spreadsheet_title).toBe('Renamed Sheet')

    await a.request(`/pipelines/${created.id}`, { method: 'DELETE' })
  })

  it('pause and resume return pipeline with updated status', async () => {
    const a = liveApp()

    // Create
    const createRes = await a.request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test' },
        destination: { type: 'test' },
      }),
    })
    const created = await createRes.json()
    await waitForPipeline(a, created.id)

    // Pause
    const pauseRes = await a.request(`/pipelines/${created.id}/pause`, { method: 'POST' })
    expect(pauseRes.status).toBe(200)
    const paused = await pauseRes.json()
    expect(paused.id).toBe(created.id)
    expect(paused.status.paused).toBe(true)

    // Resume
    const resumeRes = await a.request(`/pipelines/${created.id}/resume`, { method: 'POST' })
    expect(resumeRes.status).toBe(200)
    const resumed = await resumeRes.json()
    expect(resumed.id).toBe(created.id)
    expect(resumed.status.paused).toBe(false)

    // Cleanup
    await a.request(`/pipelines/${created.id}`, { method: 'DELETE' })
  })
})
