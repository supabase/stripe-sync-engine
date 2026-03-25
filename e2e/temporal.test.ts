import { afterAll, beforeAll, expect, it } from 'vitest'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import pg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import source from '@stripe/sync-source-stripe'
import destination from '@stripe/sync-destination-postgres'
import { createConnectorResolver } from '@stripe/sync-engine'
import { createApp, createActivities } from '@stripe/sync-service'
import { describeWithEnv } from './test-helpers.js'

// ---------------------------------------------------------------------------
// Config
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
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Could not get port'))
        return
      }
      const port = addr.port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeWithEnv('temporal e2e', ['STRIPE_API_KEY'], ({ STRIPE_API_KEY }) => {
  let testEnv: TestWorkflowEnvironment
  let server: ServerType
  let serviceUrl: string
  let pool: pg.Pool
  let dataDir: string
  const schema = schemaName()

  // workflowsPath points at compiled JS in apps/service/dist
  const workflowsPath = path.resolve(process.cwd(), '../apps/service/dist/temporal/workflows.js')

  beforeAll(async () => {
    // 1. Start Temporal test environment
    testEnv = await TestWorkflowEnvironment.createLocal()

    // 2. Isolated data directory
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temporal-e2e-'))

    // 3. Start service API on a random port
    const port = await findFreePort()
    const connectors = createConnectorResolver({
      sources: { stripe: source },
      destinations: { postgres: destination },
    })
    const app = createApp({ connectors, dataDir })
    server = serve({ fetch: app.fetch, port })
    serviceUrl = `http://localhost:${port}`

    // 4. Postgres pool
    pool = new pg.Pool({ connectionString: POSTGRES_URL })
    await pool.query('SELECT 1')

    console.log(`\n  Service:  ${serviceUrl}`)
    console.log(`  Data dir: ${dataDir}`)
    console.log(`  Postgres: ${POSTGRES_URL} (schema: ${schema})`)
  }, 120_000)

  afterAll(async () => {
    if (pool) {
      if (!process.env.KEEP_TEST_DATA) {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
      }
      await pool.end().catch(() => {})
    }
    server?.close()
    await testEnv?.teardown()
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('backfills products from Stripe into Postgres via Temporal workflow', async () => {
    // 1. Create sync with api_key directly on source config (no credential_id).
    //    Using credential_id triggers an infinite webhook fan-out queue in
    //    SyncService.run(), which would never complete for a backfill-only test.
    const syncRes = await fetch(`${serviceUrl}/syncs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: {
          type: 'stripe',
          api_key: STRIPE_API_KEY,
          backfill_limit: 5,
        },
        destination: {
          type: 'postgres',
          connection_string: POSTGRES_URL,
          schema,
        },
        streams: [{ name: 'products' }],
      }),
    })
    expect(syncRes.status).toBe(201)
    const sync = (await syncRes.json()) as { id: string }
    console.log(`  Sync: ${sync.id}`)

    // 2. Start workflow with the sync ID
    const handle = await testEnv.client.workflow.start('syncWorkflow', {
      args: [sync.id],
      workflowId: `sync_${sync.id}`,
      taskQueue: 'e2e-queue',
    })

    // 3. Create worker with real activities pointing at the service
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'e2e-queue',
      workflowsPath,
      activities: createActivities(serviceUrl),
    })

    let verificationError: string | undefined

    await worker.runUntil(async () => {
      // 4. Poll Postgres until data appears
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000))
        try {
          const result = await pool.query(`SELECT count(*) AS cnt FROM "${schema}"."products"`)
          if (parseInt(result.rows[0].cnt, 10) > 0) break
        } catch {
          // Table may not exist yet
        }
      }

      // 5. Verify data landed
      try {
        const result = await pool.query(`SELECT count(*) AS cnt FROM "${schema}"."products"`)
        const count = parseInt(result.rows[0].cnt, 10)
        console.log(`  Postgres: ${schema}.products has ${count} rows`)
        if (count === 0) verificationError = `Expected > 0 products, got ${count}`

        const row = await pool.query(
          `SELECT id, _raw_data->>'name' AS name FROM "${schema}"."products" LIMIT 1`
        )
        const sample = row.rows[0]
        console.log(`  Sample: ${sample.id} → ${sample.name}`)
        if (!sample.id.startsWith('prod_'))
          verificationError = `Expected prod_ prefix, got ${sample.id}`
      } catch (e: any) {
        verificationError = `DB verification failed: ${e.message}`
      }

      // 6. Signal delete → teardown
      await handle.signal('delete')
      try {
        await handle.result()
      } catch {
        // Expected on cancellation
      }
    })

    if (verificationError) throw new Error(verificationError)

    // 7. Verify tables dropped (teardown ran)
    if (!process.env.KEEP_TEST_DATA) {
      const { rows } = await pool.query(
        `SELECT count(*) AS cnt FROM information_schema.tables WHERE table_schema = $1`,
        [schema]
      )
      expect(parseInt(rows[0].cnt, 10)).toBe(0)
      console.log(`  Teardown verified: schema "${schema}" is empty`)
    }
  })
})
