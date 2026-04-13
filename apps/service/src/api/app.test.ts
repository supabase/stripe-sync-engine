import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import type { WorkflowClient } from '@temporalio/client'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import path from 'node:path'
import {
  createConnectorResolver,
  sourceTest,
  destinationTest,
  type ConnectorResolver,
} from '@stripe/sync-engine'
import destinationGoogleSheets from '@stripe/sync-destination-google-sheets'
import type { SyncActivities, RunResult } from '../temporal/activities/index.js'
import { createPipelineTestWorkflowEnvironment } from '../__tests__/temporal-test-env.js'
import { createApp } from './app.js'
import { memoryPipelineStore } from '../lib/stores-memory.js'
import type { PipelineStore } from '../lib/stores.js'

let resolver: ConnectorResolver

beforeAll(async () => {
  resolver = await createConnectorResolver({
    sources: { test: sourceTest },
    destinations: { test: destinationTest, google_sheets: destinationGoogleSheets },
  })
})

// Lightweight app for spec/health tests (no Temporal needed)
function app() {
  return createApp({
    temporal: { client: {} as WorkflowClient, taskQueue: 'unused' },
    resolver,
    pipelineStore: memoryPipelineStore(),
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

  it('includes pipeline and webhook paths', async () => {
    const res = await app().request('/openapi.json')
    const spec = (await res.json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(spec.paths)

    expect(paths).toContain('/pipelines')
    expect(paths).toContain('/pipelines/{id}')
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
    expect(await res.json()).toMatchObject({ ok: true, hostname: expect.any(String) })
  })
})

// ---------------------------------------------------------------------------
// Pipeline CRUD + pause/resume (in-memory Temporal, stub activities)
// ---------------------------------------------------------------------------

const workflowsPath = path.resolve(process.cwd(), 'dist/temporal/workflows')
const emptyState = { streams: {}, global: {} }
const noErrors: RunResult = { errors: [], state: emptyState }

function stubActivities(): SyncActivities {
  return {
    discoverCatalog: async () => ({ streams: [] }),
    pipelineSetup: async () => ({}),
    pipelineSync: async () => noErrors,
    pipelineTeardown: async () => {},
    updatePipelineStatus: async () => {},
  }
}

let testEnv: TestWorkflowEnvironment
let worker: Worker
let workerRunning: Promise<void>
let sharedStore: PipelineStore

beforeAll(async () => {
  testEnv = await createPipelineTestWorkflowEnvironment()
  sharedStore = memoryPipelineStore()
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
    pipelineStore: sharedStore,
  })
}

/** Poll GET /pipelines/:id until the workflow is queryable (not 404). */
async function waitForPipeline(a: ReturnType<typeof liveApp>, id: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await a.request(`/pipelines/${id}`)
    if (res.status === 200) {
      const body = await res.json()
      if (body.status) return
    }
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
        source: { type: 'test', test: {} },
        destination: { type: 'test', test: {} },
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
        source: { type: 'test', test: {} },
        destination: { type: 'test', test: {} },
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
    expect(typeof updated.status).toBe('string')

    // Cleanup
    await a.request(`/pipelines/${created.id}`, { method: 'DELETE' })
  })

  it('pause and resume return pipeline with updated status', async () => {
    const a = liveApp()

    // Create
    const createRes = await a.request('/pipelines', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test', test: {} },
        destination: { type: 'test', test: {} },
      }),
    })
    const created = await createRes.json()
    await waitForPipeline(a, created.id)

    // Pause
    const pauseRes = await a.request(`/pipelines/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ desired_status: 'paused' }),
    })
    expect(pauseRes.status).toBe(200)
    const paused = await pauseRes.json()
    expect(paused.id).toBe(created.id)
    expect(paused.desired_status).toBe('paused')

    // Resume
    const resumeRes = await a.request(`/pipelines/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ desired_status: 'active' }),
    })
    expect(resumeRes.status).toBe(200)
    const resumed = await resumeRes.json()
    expect(resumed.id).toBe(created.id)
    expect(resumed.desired_status).toBe('active')

    // Cleanup
    await a.request(`/pipelines/${created.id}`, { method: 'DELETE' })
  })
})
