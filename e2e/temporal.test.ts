import { afterAll, beforeAll, expect, it } from 'vitest'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import pg from 'pg'
import Stripe from 'stripe'
import { google } from 'googleapis'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import source from '@stripe/sync-source-stripe'
import pgDestination from '@stripe/sync-destination-postgres'
import sheetsDestination from '@stripe/sync-destination-google-sheets'
import { readSheet } from '@stripe/sync-destination-google-sheets'
import { createConnectorResolver } from '@stripe/sync-engine'
import { createApp, createActivities } from '@stripe/sync-service'
import { describeWithEnv } from './test-helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POSTGRES_URL =
  process.env.POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres'

function schemaName(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const rand = Math.floor(Math.random() * 1000)
  return `temporal_e2e_${ts}_${rand}`
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Could not get port'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function pollUntil(
  fn: () => Promise<boolean>,
  { timeout = 60_000, interval = 1000 } = {}
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`pollUntil timed out after ${timeout}ms`)
}

/** Create shared infra: Temporal test env, service API, Postgres pool. */
function createTestInfra() {
  let testEnv: TestWorkflowEnvironment
  let server: ServerType
  let serviceUrl: string
  let pool: pg.Pool
  let dataDir: string

  const workflowsPath = path.resolve(process.cwd(), '../apps/service/dist/temporal/workflows.js')

  return {
    get testEnv() {
      return testEnv
    },
    get serviceUrl() {
      return serviceUrl
    },
    get pool() {
      return pool
    },
    get workflowsPath() {
      return workflowsPath
    },

    async setup() {
      testEnv = await TestWorkflowEnvironment.createLocal()
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temporal-e2e-'))

      const port = await findFreePort()
      const connectors = createConnectorResolver({
        sources: { stripe: source },
        destinations: { postgres: pgDestination, 'google-sheets': sheetsDestination },
      })
      const app = createApp({ connectors, dataDir })
      server = serve({ fetch: app.fetch, port })
      serviceUrl = `http://localhost:${port}`

      pool = new pg.Pool({ connectionString: POSTGRES_URL })
      await pool.query('SELECT 1')

      console.log(`\n  Service:  ${serviceUrl}`)
      console.log(`  Data dir: ${dataDir}`)
      console.log(`  Postgres: ${POSTGRES_URL}`)
    },

    async teardown() {
      await pool?.end().catch(() => {})
      server?.close()
      await testEnv?.teardown()
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

// ===========================================================================
// 1. Stripe → Postgres (backfill + live webhook event)
// ===========================================================================

describeWithEnv('temporal e2e: stripe → postgres', ['STRIPE_API_KEY'], ({ STRIPE_API_KEY }) => {
  const infra = createTestInfra()
  const schema = schemaName()
  let stripe: Stripe

  beforeAll(async () => {
    await infra.setup()
    stripe = new Stripe(STRIPE_API_KEY)
    console.log(`  Schema: ${schema}`)
  }, 120_000)

  afterAll(async () => {
    if (infra.pool && !process.env.KEEP_TEST_DATA) {
      await infra.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    }
    await infra.teardown()
  })

  it('backfills products then processes a live event via signal', async () => {
    // --- Create sync (api_key inline — no credential_id to avoid infinite queue) ---
    const syncRes = await fetch(`${infra.serviceUrl}/syncs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'stripe', api_key: STRIPE_API_KEY, backfill_limit: 5 },
        destination: { type: 'postgres', connection_string: POSTGRES_URL, schema },
        streams: [{ name: 'products' }],
      }),
    })
    expect(syncRes.status).toBe(201)
    const sync = (await syncRes.json()) as { id: string }
    console.log(`  Sync: ${sync.id}`)

    // --- Start workflow + worker ---
    const handle = await infra.testEnv.client.workflow.start('syncWorkflow', {
      args: [sync.id],
      workflowId: `sync_${sync.id}`,
      taskQueue: 'pg-queue',
    })

    const worker = await Worker.create({
      connection: infra.testEnv.nativeConnection,
      taskQueue: 'pg-queue',
      workflowsPath: infra.workflowsPath,
      activities: createActivities(infra.serviceUrl),
    })

    await worker.runUntil(async () => {
      // --- Wait for backfill data ---
      await pollUntil(async () => {
        try {
          const r = await infra.pool.query(`SELECT count(*) AS cnt FROM "${schema}"."products"`)
          return parseInt(r.rows[0].cnt, 10) > 0
        } catch {
          return false
        }
      })

      const { rows: countRows } = await infra.pool.query(
        `SELECT count(*) AS cnt FROM "${schema}"."products"`
      )
      const backfillCount = parseInt(countRows[0].cnt, 10)
      console.log(`  Backfill: ${backfillCount} products`)
      expect(backfillCount).toBeGreaterThan(0)

      // Verify data shape
      const { rows: sampleRows } = await infra.pool.query(
        `SELECT id, _raw_data->>'name' AS name FROM "${schema}"."products" LIMIT 1`
      )
      expect(sampleRows[0].id).toMatch(/^prod_/)
      console.log(`  Sample: ${sampleRows[0].id} → ${sampleRows[0].name}`)

      // --- Live event via stripe_event signal ---
      // Update a product via Stripe API
      const products = await stripe.products.list({ limit: 1 })
      const product = products.data[0]
      const newName = `temporal-e2e-${Date.now()}`
      await stripe.products.update(product.id, { name: newName })
      console.log(`  Updated product ${product.id} → "${newName}"`)

      // Fetch the event from Stripe events API and signal the workflow
      await new Promise((r) => setTimeout(r, 2000))
      const events = await stripe.events.list({ limit: 5, type: 'product.updated' })
      const event = events.data[0]
      console.log(`  Fetched event ${event.id} (${event.type})`)
      await handle.signal('stripe_event', event)

      // Wait for the event to be processed
      await new Promise((r) => setTimeout(r, 5000))

      // Verify the update landed
      const { rows: updatedRows } = await infra.pool.query(
        `SELECT _raw_data->>'name' AS name FROM "${schema}"."products" WHERE id = $1`,
        [product.id]
      )
      expect(updatedRows.length).toBeGreaterThan(0)
      expect(updatedRows[0].name).toBe(newName)
      console.log(`  Live update verified: ${product.id} → "${updatedRows[0].name}"`)

      // --- Teardown ---
      await handle.signal('delete')
      try {
        await handle.result()
      } catch {
        // Expected on cancellation
      }
    })

    // Verify tables dropped
    if (!process.env.KEEP_TEST_DATA) {
      const { rows } = await infra.pool.query(
        `SELECT count(*) AS cnt FROM information_schema.tables WHERE table_schema = $1`,
        [schema]
      )
      expect(parseInt(rows[0].cnt, 10)).toBe(0)
      console.log(`  Teardown verified: schema "${schema}" is empty`)
    }
  })
})

// ===========================================================================
// 2. Stripe → Google Sheets (backfill)
// ===========================================================================

describeWithEnv(
  'temporal e2e: stripe → google-sheets',
  [
    'STRIPE_API_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REFRESH_TOKEN',
    'GOOGLE_SPREADSHEET_ID',
  ],
  ({
    STRIPE_API_KEY,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN,
    GOOGLE_SPREADSHEET_ID,
  }) => {
    const infra = createTestInfra()
    let sheetsClient: ReturnType<typeof google.sheets>

    // The stream name "products" becomes the sheet tab name.
    // We clean up the tab after the test.
    const streamName = 'products'

    beforeAll(async () => {
      await infra.setup()

      const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
      auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN })
      sheetsClient = google.sheets({ version: 'v4', auth })

      console.log(`  Spreadsheet: ${GOOGLE_SPREADSHEET_ID}`)
      console.log(`  Tab: ${streamName}`)
    }, 120_000)

    afterAll(async () => {
      // Clean up test tab
      if (sheetsClient && !process.env.KEEP_TEST_DATA) {
        try {
          const meta = await sheetsClient.spreadsheets.get({
            spreadsheetId: GOOGLE_SPREADSHEET_ID,
          })
          const sheet = meta.data.sheets?.find((s) => s.properties?.title === streamName)
          if (sheet?.properties?.sheetId != null) {
            await sheetsClient.spreadsheets.batchUpdate({
              spreadsheetId: GOOGLE_SPREADSHEET_ID,
              requestBody: {
                requests: [{ deleteSheet: { sheetId: sheet.properties.sheetId } }],
              },
            })
            console.log(`  Cleaned up tab: ${streamName}`)
          }
        } catch {
          // Ignore cleanup errors
        }
      }
      await infra.teardown()
    })

    it('backfills products from Stripe into a Google Sheet tab', async () => {
      // --- Create sync ---
      const syncRes = await fetch(`${infra.serviceUrl}/syncs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: { type: 'stripe', api_key: STRIPE_API_KEY, backfill_limit: 3 },
          destination: {
            type: 'google-sheets',
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: GOOGLE_REFRESH_TOKEN,
            access_token: 'placeholder', // OAuth2 will refresh via refresh_token
            spreadsheet_id: GOOGLE_SPREADSHEET_ID,
          },
          // Use the unique tab name as the stream name —
          // the sheets destination creates a tab per stream
          streams: [{ name: streamName }],
        }),
      })
      expect(syncRes.status).toBe(201)
      const sync = (await syncRes.json()) as { id: string }
      console.log(`  Sync: ${sync.id}`)

      // --- Start workflow + worker ---
      const handle = await infra.testEnv.client.workflow.start('syncWorkflow', {
        args: [sync.id],
        workflowId: `sync_${sync.id}`,
        taskQueue: 'sheets-queue',
      })

      const worker = await Worker.create({
        connection: infra.testEnv.nativeConnection,
        taskQueue: 'sheets-queue',
        workflowsPath: infra.workflowsPath,
        activities: createActivities(infra.serviceUrl),
      })

      await worker.runUntil(async () => {
        // --- Wait for data to appear in the sheet ---
        await pollUntil(
          async () => {
            try {
              const rows = await readSheet(sheetsClient, GOOGLE_SPREADSHEET_ID, streamName)
              return rows.length > 1 // header + at least one data row
            } catch {
              return false
            }
          },
          { timeout: 60_000, interval: 2000 }
        )

        // --- Verify data ---
        const rows = await readSheet(sheetsClient, GOOGLE_SPREADSHEET_ID, streamName)
        const headerRow = rows[0]
        const dataRows = rows.slice(1)
        console.log(`  Sheet: ${dataRows.length} data rows`)
        console.log(`  Headers: ${headerRow.join(', ')}`)

        expect(dataRows.length).toBeGreaterThan(0)

        // Find the 'id' column and verify product IDs
        const idCol = headerRow.indexOf('id')
        expect(idCol).toBeGreaterThanOrEqual(0)
        for (const row of dataRows) {
          expect(row[idCol]).toMatch(/^prod_/)
        }
        console.log(`  Sample: ${dataRows[0][idCol]}`)

        // --- Signal delete ---
        await handle.signal('delete')
        try {
          await handle.result()
        } catch {
          // Expected
        }
      })
    })
  }
)
