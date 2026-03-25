import { describe, it, expect } from 'vitest'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import { createActivities } from '../../activities'
import type { SyncConfig } from '../../types'
import { spawn, ChildProcess } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import pg from 'pg'
import Stripe from 'stripe'

const STRIPE_API_KEY = process.env.STRIPE_API_KEY!
const POSTGRES_URL =
  process.env.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5432/postgres'
const repoRoot = path.resolve(process.cwd(), '../..')

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

function startStatelessApi(port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const engineDir = path.join(repoRoot, 'apps/engine')
    const apiEntry = path.join(engineDir, 'dist/api/index.js')

    const proc = spawn('node', [apiEntry], {
      cwd: engineDir,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Wait for server to accept connections
    let attempts = 0
    const maxAttempts = 60
    const interval = setInterval(() => {
      attempts++
      const socket = new net.Socket()
      socket
        .connect(port, '127.0.0.1', () => {
          socket.destroy()
          clearInterval(interval)
          resolve(proc)
        })
        .on('error', () => {
          socket.destroy()
          if (attempts >= maxAttempts) {
            clearInterval(interval)
            proc.kill('SIGTERM')
            reject(
              new Error(
                `Stateless API failed to start on port ${port} after ${maxAttempts} attempts`
              )
            )
          }
        })
    }, 500)

    proc.on('error', (err) => {
      clearInterval(interval)
      reject(err)
    })
  })
}

function schemaName(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const rand = Math.floor(Math.random() * 1000)
  return `temporal_e2e_${ts}_${rand}`
}

describe(
  'SyncWorkflow E2E',
  () => {
    it('backfills products from Stripe into Postgres via Temporal workflow', async () => {
      const apiPort = await findFreePort()
      let apiProc: ChildProcess | undefined
      let pgClient: pg.Client | undefined
      let testEnv: TestWorkflowEnvironment | undefined
      const schema = schemaName()

      try {
        apiProc = await startStatelessApi(apiPort)
        const engineUrl = `http://localhost:${apiPort}`

        pgClient = new pg.Client(POSTGRES_URL)
        await pgClient.connect()

        const config: SyncConfig = {
          source_name: 'stripe',
          destination_name: 'postgres',
          source_config: {
            api_key: STRIPE_API_KEY,
            backfill_limit: 5,
          },
          destination_config: {
            connection_string: POSTGRES_URL,
            schema,
          },
          streams: [{ name: 'products' }],
        }

        testEnv = await TestWorkflowEnvironment.createLocal()

        const handle = await testEnv.client.workflow.start('syncWorkflow', {
          args: [config],
          workflowId: `temporal-e2e-${schema}`,
          taskQueue: 'e2e-queue',
        })

        const worker = await Worker.create({
          connection: testEnv.nativeConnection,
          taskQueue: 'e2e-queue',
          workflowsPath: path.resolve(process.cwd(), 'dist/workflows.js'),
          activities: createActivities(engineUrl),
        })

        let verificationError: string | undefined

        await worker.runUntil(async () => {
          // Poll until live phase (backfill complete)
          while (true) {
            await new Promise((r) => setTimeout(r, 1000))
            try {
              const status = await handle.query('status')
              if (status.phase === 'live') break
            } catch {
              // Workflow not ready yet
            }
          }

          // Extra wait for data to settle
          await new Promise((r) => setTimeout(r, 1000))

          // Verify data before teardown
          try {
            const result = await pgClient!.query(
              `SELECT count(*) AS cnt FROM "${schema}"."products"`
            )
            const count = parseInt(result.rows[0].cnt, 10)
            console.log(`  Postgres: ${schema}.products has ${count} rows`)
            if (count === 0) verificationError = `Expected > 0 products, got ${count}`

            const row = await pgClient!.query(
              `SELECT id, _raw_data->>'name' AS name FROM "${schema}"."products" LIMIT 1`
            )
            const sample = row.rows[0]
            console.log(`  Sample: ${sample.id} → ${sample.name}`)
            if (!sample.id.startsWith('prod_'))
              verificationError = `Expected prod_ prefix, got ${sample.id}`
          } catch (e: any) {
            verificationError = `DB verification failed: ${e.message}`
          }

          if (process.env.KEEP_TEST_DATA) {
            await handle.cancel()
          } else {
            await handle.signal('delete')
          }

          try {
            await handle.result()
          } catch {
            // Expected when KEEP_TEST_DATA cancels
          }
        })

        if (verificationError) throw new Error(verificationError)
      } finally {
        if (pgClient) {
          if (!process.env.KEEP_TEST_DATA) {
            await pgClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
          }
          await pgClient.end().catch(() => {})
        }
        if (apiProc) {
          apiProc.kill('SIGTERM')
        }
        await testEnv?.teardown()
      }
    })

    it('processes a live Stripe event via signal after backfill', async () => {
      const apiPort = await findFreePort()
      let apiProc: ChildProcess | undefined
      let pgClient: pg.Client | undefined
      let testEnv: TestWorkflowEnvironment | undefined
      const schema = schemaName()

      try {
        apiProc = await startStatelessApi(apiPort)
        const engineUrl = `http://localhost:${apiPort}`

        pgClient = new pg.Client(POSTGRES_URL)
        await pgClient.connect()

        const stripe = new Stripe(STRIPE_API_KEY)

        const config: SyncConfig = {
          source_name: 'stripe',
          destination_name: 'postgres',
          source_config: {
            api_key: STRIPE_API_KEY,
            backfill_limit: 3,
          },
          destination_config: {
            connection_string: POSTGRES_URL,
            schema,
          },
          streams: [{ name: 'products' }],
        }

        testEnv = await TestWorkflowEnvironment.createLocal()

        const handle = await testEnv.client.workflow.start('syncWorkflow', {
          args: [config],
          workflowId: `temporal-e2e-live-${schema}`,
          taskQueue: 'e2e-queue',
        })

        const worker = await Worker.create({
          connection: testEnv.nativeConnection,
          taskQueue: 'e2e-queue',
          workflowsPath: path.resolve(process.cwd(), 'dist/workflows.js'),
          activities: createActivities(engineUrl),
        })

        let verificationError: string | undefined

        await worker.runUntil(async () => {
          // Poll until live phase
          while (true) {
            await new Promise((r) => setTimeout(r, 1000))
            try {
              const status = await handle.query('status')
              if (status.phase === 'live') break
            } catch {
              // Workflow not ready yet
            }
          }

          // Trigger a product update via Stripe API
          const products = await stripe.products.list({ limit: 1 })
          const product = products.data[0]
          const newName = `temporal-e2e-${Date.now()}`
          await stripe.products.update(product.id, { name: newName })
          console.log(`  Updated product ${product.id} → ${newName}`)

          // Fetch the event from Stripe events API
          await new Promise((r) => setTimeout(r, 2000))
          const events = await stripe.events.list({
            limit: 5,
            type: 'product.updated',
          })
          const event = events.data[0]
          console.log(`  Fetched event ${event.id} (${event.type})`)

          // Signal the event to the workflow
          await handle.signal('stripe_event', event)

          // Wait for processing, then verify
          await new Promise((r) => setTimeout(r, 3000))

          try {
            const result = await pgClient!.query(
              `SELECT count(*) AS cnt FROM "${schema}"."products"`
            )
            const count = parseInt(result.rows[0].cnt, 10)
            console.log(`  Postgres: ${schema}.products has ${count} rows`)
            if (count === 0) verificationError = `Expected > 0 products, got ${count}`
          } catch (e: any) {
            verificationError = `DB verification failed: ${e.message}`
          }

          await handle.signal('delete')

          try {
            await handle.result()
          } catch {
            // Expected on cancellation
          }
        })

        if (verificationError) throw new Error(verificationError)
      } finally {
        if (pgClient) {
          if (!process.env.KEEP_TEST_DATA) {
            await pgClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
          }
          await pgClient.end().catch(() => {})
        }
        if (apiProc) {
          apiProc.kill('SIGTERM')
        }
        await testEnv?.teardown()
      }
    })
  },
  { timeout: 120_000 }
)
