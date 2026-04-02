import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { Client, Connection } from '@temporalio/client'
import { NativeConnection, Worker } from '@temporalio/worker'
import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import createFetchClient from 'openapi-fetch'
import pg from 'pg'
import Stripe from 'stripe'
import sourceStripe from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'
import { createApp as createEngineApp, createConnectorResolver } from '@stripe/sync-engine'
import { createActivities } from '../temporal/activities.js'
import { createApp } from './app.js'
import type { paths } from '../__generated__/openapi.js'

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

const TEMPORAL_ADDRESS = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233'
const STRIPE_API_KEY = process.env['STRIPE_API_KEY']!
const POSTGRES_URL = process.env['POSTGRES_URL'] ?? process.env['DATABASE_URL']!
const TASK_QUEUE = `test-app-${Date.now()}`
const SCHEMA = `integration_${Date.now()}`
const workflowsPath = path.resolve(process.cwd(), 'dist/temporal/workflows.js')

const SKIP_CLEANUP = process.env['SKIP_CLEANUP'] === '1'

// ---------------------------------------------------------------------------
// Webhook.site helpers
// ---------------------------------------------------------------------------

async function createWebhookSiteToken(): Promise<{ uuid: string; url: string }> {
  const res = await fetch('https://webhook.site/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      default_status: 200,
      default_content: 'OK',
      default_content_type: 'text/plain',
    }),
  })
  const data = (await res.json()) as { uuid: string }
  return { uuid: data.uuid, url: `https://webhook.site/${data.uuid}` }
}

async function deleteWebhookSiteToken(uuid: string): Promise<void> {
  await fetch(`https://webhook.site/token/${uuid}`, { method: 'DELETE' }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Real connectors, real servers, real Temporal
// ---------------------------------------------------------------------------

const resolver = createConnectorResolver({
  sources: { stripe: sourceStripe },
  destinations: { postgres: destinationPostgres },
})

let client: Client
let worker: Worker
let workerRunning: Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let engineServer: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serviceServer: any
let serviceUrl: string
let pool: pg.Pool
let webhookToken: { uuid: string; url: string } | null = null
let whcliProcess: ChildProcess | null = null

beforeAll(async () => {
  execSync('pnpm --filter @stripe/sync-service build', {
    cwd: path.resolve(process.cwd(), '../..'),
    stdio: 'pipe',
  })

  pool = new pg.Pool({ connectionString: POSTGRES_URL })
  await pool.query('SELECT 1')

  const engineApp = createEngineApp(resolver)
  const engineUrl = await new Promise<string>((resolve) => {
    engineServer = serve(
      {
        fetch: engineApp.fetch,
        port: 0,
        serverOptions: { maxHeaderSize: 128 * 1024 },
      },
      (info) => resolve(`http://localhost:${(info as AddressInfo).port}`)
    )
  })

  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS })
  client = new Client({ connection })

  const nativeConnection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS })
  worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities: createActivities({ engineUrl }),
  })
  workerRunning = worker.run()

  const serviceApp = createApp({
    temporal: { client: client.workflow, taskQueue: TASK_QUEUE },
    resolver,
  })
  serviceUrl = await new Promise<string>((resolve) => {
    serviceServer = serve({ fetch: serviceApp.fetch, port: 0 }, (info) => {
      resolve(`http://localhost:${(info as AddressInfo).port}`)
    })
  })

  console.log(`  Schema:   ${SCHEMA}`)
  console.log(`  Postgres: ${POSTGRES_URL}`)
  console.log(`  Cleanup:  ${SKIP_CLEANUP ? 'no (SKIP_CLEANUP=1)' : 'yes'}`)
}, 60_000)

afterAll(async () => {
  if (whcliProcess) {
    whcliProcess.kill()
    whcliProcess = null
  }
  if (webhookToken?.uuid) {
    await deleteWebhookSiteToken(webhookToken.uuid)
  }
  worker?.shutdown()
  await workerRunning
  await new Promise<void>((r, e) =>
    engineServer?.close((err: Error | null) => (err ? e(err) : r()))
  )
  await new Promise<void>((r, e) =>
    serviceServer?.close((err: Error | null) => (err ? e(err) : r()))
  )
  if (!SKIP_CLEANUP) {
    await pool?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {})
  }
  await pool?.end().catch(() => {})
})

function api() {
  return createFetchClient<paths>({ baseUrl: serviceUrl })
}

async function pollUntil(
  fn: () => Promise<boolean>,
  { timeout = 60_000, interval = 2000 } = {}
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`pollUntil timed out after ${timeout}ms`)
}

// ---------------------------------------------------------------------------
// Full pipeline lifecycle: CRUD → backfill → webhook → cleanup
// ---------------------------------------------------------------------------

describe('pipeline integration', () => {
  it('create → backfill → webhook update → delete → verify cleanup', async () => {
    const c = api()
    const stripe = new Stripe(STRIPE_API_KEY)

    // 1. Create webhook.site token for public webhook URL
    webhookToken = await createWebhookSiteToken()
    console.log(`  Webhook URL: ${webhookToken.url}`)

    // 2. Create pipeline with webhook_url
    const { data: created, error: createErr } = await c.POST('/pipelines', {
      body: {
        source: { type: 'stripe', api_key: STRIPE_API_KEY, webhook_url: webhookToken.url },
        destination: { type: 'postgres', connection_string: POSTGRES_URL, schema: SCHEMA },
        streams: [{ name: 'products' }],
      },
    })
    expect(createErr).toBeUndefined()
    expect(created!.id).toMatch(/^pipe_/)
    const id = created!.id
    console.log(`  Pipeline: ${id}`)

    // 3. Wait for workflow to start, then verify CRUD operations
    await new Promise((r) => setTimeout(r, 2000))

    const { data: got, error: getErr } = await c.GET('/pipelines/{id}', {
      params: { path: { id } },
    })
    expect(getErr).toBeUndefined()
    expect(got!.status?.phase).toBeDefined()

    const { data: list, error: listErr } = await c.GET('/pipelines')
    expect(listErr).toBeUndefined()
    expect(list!.data.length).toBeGreaterThanOrEqual(1)

    // 4. Verify setup created the Stripe webhook endpoint
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 })
    const managed = endpoints.data.find(
      (wh) => wh.url === webhookToken!.url && wh.metadata?.managed_by === 'stripe-sync'
    )
    expect(managed).toBeDefined()
    console.log(`  Stripe webhook endpoint: ${managed!.id}`)

    // 5. Wait for backfill to land in Postgres
    await pollUntil(async () => {
      try {
        const r = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."products"`)
        return r.rows[0].n > 0
      } catch {
        return false
      }
    })
    const { rows: backfillRows } = await pool.query(
      `SELECT count(*)::int AS n FROM "${SCHEMA}"."products"`
    )
    console.log(`  Backfilled ${backfillRows[0].n} products`)

    const { rows: sample } = await pool.query(`SELECT id FROM "${SCHEMA}"."products" LIMIT 1`)
    expect(sample[0].id).toMatch(/^prod_/)

    // 6. Start whcli forward: webhook.site → local service
    const whcliTarget = `${serviceUrl}/webhooks/${id}`
    console.log(`  Forwarding: ${webhookToken.url} → ${whcliTarget}`)
    whcliProcess = spawn(
      'pnpm',
      ['exec', 'whcli', 'forward', `--token=${webhookToken.uuid}`, `--target=${whcliTarget}`],
      { cwd: path.resolve(process.cwd(), '../..'), stdio: 'pipe' }
    )
    await new Promise((r) => setTimeout(r, 2000))

    // 7. Update a product via Stripe API → triggers webhook → updates row
    const productId = sample[0].id as string
    const marker = `webhook-test-${Date.now()}`
    console.log(`  Updating product ${productId} name → ${marker}`)
    await stripe.products.update(productId, { name: marker })

    // 8. Poll until the updated name appears in Postgres
    await pollUntil(
      async () => {
        try {
          const r = await pool.query(`SELECT name FROM "${SCHEMA}"."products" WHERE id = $1`, [
            productId,
          ])
          return r.rows[0]?.name === marker
        } catch {
          return false
        }
      },
      { timeout: 30_000, interval: 2000 }
    )
    const { rows: updatedRows } = await pool.query(
      `SELECT name FROM "${SCHEMA}"."products" WHERE id = $1`,
      [productId]
    )
    expect(updatedRows[0].name).toBe(marker)
    console.log(`  Verified: product name updated via webhook`)

    // 9. Delete pipeline → teardown removes Stripe webhook
    const { data: deleted, error: deleteErr } = await c.DELETE('/pipelines/{id}', {
      params: { path: { id } },
    })
    expect(deleteErr).toBeUndefined()
    expect(deleted).toEqual({ id, deleted: true })

    const handle = client.workflow.getHandle(id)
    await handle.result()

    // 10. Verify the specific webhook endpoint is gone
    const endpointsAfter = await stripe.webhookEndpoints.list({ limit: 100 })
    const stillExists = endpointsAfter.data.find((wh) => wh.id === managed!.id)
    expect(stillExists).toBeUndefined()
    console.log(`  Verified: webhook endpoint ${managed!.id} deleted`)

    // 11. Pipeline should be gone from list and get
    const { data: listAfter } = await c.GET('/pipelines')
    expect(listAfter!.data.find((p: any) => p.id === id)).toBeUndefined()

    const { error: getAfter } = await c.GET('/pipelines/{id}', {
      params: { path: { id } },
    })
    expect(getAfter).toBeDefined()
  }, 120_000)

  it('returns 404 for non-existent pipeline', async () => {
    const { error } = await api().GET('/pipelines/{id}', {
      params: { path: { id: 'pipe_nope' } },
    })
    expect(error).toBeDefined()
  })
})
