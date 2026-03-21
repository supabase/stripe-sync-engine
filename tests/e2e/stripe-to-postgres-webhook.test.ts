import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { serve } from '@hono/node-server'
import pg from 'pg'
import Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnectorResolver } from '@stripe/stateless-sync'
import source from '@stripe/source-stripe'
import destination from '@stripe/destination-postgres'
import { createApp } from '@stripe/sync-engine-stateful'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STRIPE_API_KEY = process.env.STRIPE_API_KEY!
const POSTGRES_URL =
  process.env.POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres'
const ts = new Date()
  .toISOString()
  .replace(/[-:T.Z]/g, '')
  .slice(0, 15)
// Two schemas: one per sync
const SCHEMA_A = `e2e_wh_a_${ts}` // sync A: products only
const SCHEMA_B = `e2e_wh_b_${ts}` // sync B: products + customers

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${await res.text()}`)
  return res.json()
}

async function patchJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`PATCH ${url} → ${res.status}: ${await res.text()}`)
  return res.json()
}

/** Drain a streaming NDJSON run response, calling onMsg for each parsed message. */
async function drainStream(
  res: Response,
  onMsg: (msg: Record<string, unknown>) => void
): Promise<void> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          onMsg(JSON.parse(line) as Record<string, unknown>)
        } catch {}
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') throw err
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let apiPort: number
let dataDir: string
let apiServer: ReturnType<typeof serve>
let stripeListenProc: ChildProcess | null = null
let pool: pg.Pool
let stripe: Stripe

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STRIPE_API_KEY) return

  pool = new pg.Pool({ connectionString: POSTGRES_URL })
  await pool.query('SELECT 1')

  stripe = new Stripe(STRIPE_API_KEY)
  const account = await stripe.accounts.retrieve()
  const isTest = STRIPE_API_KEY.startsWith('sk_test_')
  const dashPrefix = isTest ? 'dashboard.stripe.com/test' : 'dashboard.stripe.com'
  console.log(`\n  Stripe:   ${account.id} → https://${dashPrefix}/developers`)
  console.log(`  Postgres: ${POSTGRES_URL}`)
  console.log(`  Schemas:  ${SCHEMA_A} (products) | ${SCHEMA_B} (products + customers)`)

  dataDir = mkdtempSync(path.join(tmpdir(), 'e2e-wh-'))
  apiPort = await getFreePort()

  const connectors = createConnectorResolver({
    sources: { 'stripe-api-core': source },
    destinations: { postgres: destination },
  })
  const app = createApp({ dataDir, connectors })
  apiServer = serve({ fetch: app.fetch, port: apiPort })

  console.log(`  Stateful API: http://localhost:${apiPort}`)
}, 30_000)

afterAll(async () => {
  stripeListenProc?.kill()
  apiServer?.close()

  if (pool) {
    if (!process.env.KEEP_TEST_DATA) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_A}" CASCADE`).catch(() => {})
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA_B}" CASCADE`).catch(() => {})
    }
    await pool.end()
  }

  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
}, 30_000)

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.STRIPE_API_KEY)('stripe → postgres via webhook (stateful API)', () => {
  it('fans out events to two syncs; each only writes the streams in its catalog', async () => {
    const base = `http://localhost:${apiPort}`

    // 1. One shared Stripe credential — fan-out is keyed by credential_id
    const srcCred = (await postJson(`${base}/credentials`, {
      type: 'stripe-api-core',
      api_key: STRIPE_API_KEY,
    })) as { id: string }

    // 2. One shared Postgres credential
    const pgCred = (await postJson(`${base}/credentials`, {
      type: 'postgres',
      connection_string: POSTGRES_URL,
    })) as { id: string }

    // 3. Start stripe-cli — one listener, one credential_id → one fan-out target
    const forwardTo = `http://host.docker.internal:${apiPort}/webhooks/${srcCred.id}`
    const dockerArgs = [
      'run',
      '--rm',
      ...(process.platform !== 'darwin' ? ['--add-host=host.docker.internal:host-gateway'] : []),
      'stripe/stripe-cli:latest',
      'listen',
      '--api-key',
      STRIPE_API_KEY,
      '--forward-to',
      forwardTo,
    ]
    stripeListenProc = spawn('docker', dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

    const webhookSecret = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('stripe listen: timed out waiting for signing secret')),
        60_000
      )
      let buf = ''
      const handler = (data: Buffer) => {
        const text = data.toString()
        process.stderr.write(`[stripe-cli] ${text}`)
        buf += text
        const match = buf.match(/whsec_\S+/)
        if (match) {
          clearTimeout(timer)
          resolve(match[0])
        }
      }
      stripeListenProc!.stdout?.on('data', handler)
      stripeListenProc!.stderr?.on('data', handler)
      stripeListenProc!.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      stripeListenProc!.on('exit', (code) => {
        if (code != null && code !== 0) {
          clearTimeout(timer)
          reject(new Error(`stripe listen exited with code ${code}: ${buf}`))
        }
      })
    })
    stripeListenProc!.stdout?.on('data', (d: Buffer) => process.stderr.write(`[stripe-cli] ${d}`))
    stripeListenProc!.stderr?.on('data', (d: Buffer) => process.stderr.write(`[stripe-cli] ${d}`))

    console.log(`  stripe-cli: forwarding to ${forwardTo}`)
    console.log(`  webhook secret: ${webhookSecret.slice(0, 14)}...`)

    // 4. Patch credential with webhook_secret
    await patchJson(`${base}/credentials/${srcCred.id}`, { webhook_secret: webhookSecret })

    const sourceConfig = {
      type: 'stripe-api-core',
      livemode: !STRIPE_API_KEY.startsWith('sk_test_'),
      api_version: '2025-04-30.basil',
      credential_id: srcCred.id,
    }

    // 5a. Sync A — products only → SCHEMA_A
    const syncA = (await postJson(`${base}/syncs`, {
      account_id: 'acct_test',
      status: 'syncing',
      source: sourceConfig,
      destination: { type: 'postgres', schema: SCHEMA_A, credential_id: pgCred.id },
      streams: [{ name: 'products' }],
    })) as { id: string }

    // 5b. Sync B — products + customers → SCHEMA_B
    //     Both syncs share srcCred.id so push_event() delivers to both.
    //     Stream filtering happens inside each sync's source.read($stdin).
    const syncB = (await postJson(`${base}/syncs`, {
      account_id: 'acct_test',
      status: 'syncing',
      source: sourceConfig,
      destination: { type: 'postgres', schema: SCHEMA_B, credential_id: pgCred.id },
      streams: [{ name: 'products' }, { name: 'customers' }],
    })) as { id: string }

    console.log(`  Sync A (${syncA.id}): [products]            → ${SCHEMA_A}`)
    console.log(`  Sync B (${syncB.id}): [products, customers] → ${SCHEMA_B}`)

    // 6. Start both runs — registers two input queues under srcCred.id
    const acA = new AbortController()
    const acB = new AbortController()
    const [runA, runB] = await Promise.all([
      fetch(`${base}/syncs/${syncA.id}/run`, { method: 'POST', signal: acA.signal }),
      fetch(`${base}/syncs/${syncB.id}/run`, { method: 'POST', signal: acB.signal }),
    ])
    expect(runA.status).toBe(200)
    expect(runB.status).toBe(200)

    // 7. Watch both response streams for state checkpoints
    const errors: string[] = []
    let productInA = false
    let productInB = false
    let customerInB = false

    const doneA = drainStream(runA, (msg) => {
      if (msg.type === 'state' && msg.stream === 'products' && (msg.data as any)?.eventId)
        productInA = true
      if (msg.type === 'error') errors.push((msg.message as string) ?? JSON.stringify(msg))
    })
    const doneB = drainStream(runB, (msg) => {
      if (msg.type === 'state' && msg.stream === 'products' && (msg.data as any)?.eventId)
        productInB = true
      if (msg.type === 'state' && msg.stream === 'customers' && (msg.data as any)?.eventId)
        customerInB = true
      if (msg.type === 'error') errors.push((msg.message as string) ?? JSON.stringify(msg))
    })

    // 8. Wait for both destination setups to complete
    await new Promise((r) => setTimeout(r, 2_000))

    // 9. Trigger product.updated — fans out to BOTH syncs, both process it
    const products = await stripe.products.list({ limit: 1 })
    expect(products.data.length).toBeGreaterThan(0)
    const product = products.data[0]
    const newProductName = `e2e-wh-prod-${Date.now()}`
    await stripe.products.update(product.id, { name: newProductName })
    console.log(`  product.updated: ${product.id} → "${newProductName}"`)

    // 10. Trigger customer.updated — fans out to BOTH syncs, but only sync B
    //     writes it (customers not in sync A's catalog → silently filtered)
    const customerList = await stripe.customers.list({ limit: 1 })
    const customer = customerList.data[0] ?? (await stripe.customers.create({ name: 'e2e test' }))
    const newCustomerName = `e2e-wh-cust-${Date.now()}`
    await stripe.customers.update(customer.id, { name: newCustomerName })
    console.log(`  customer.updated: ${customer.id} → "${newCustomerName}"`)

    // 11. Poll until all three checkpoints arrive (up to 60s)
    const deadline = Date.now() + 60_000
    while ((!productInA || !productInB || !customerInB) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
    }
    console.log(
      `  Checkpoints: A.products=${productInA}  B.products=${productInB}  B.customers=${customerInB}`
    )

    // 12. Stop both syncs
    acA.abort()
    acB.abort()
    await Promise.all([doneA, doneB])

    if (errors.length) console.error('  sync errors:', errors)

    // 13. Fan-out: both syncs must have received and processed the product event
    expect(productInA).toBe(true)
    expect(productInB).toBe(true)

    // 14. Customer event delivered to sync B only (has customers in catalog)
    expect(customerInB).toBe(true)

    // 15. Verify product in SCHEMA_A
    const { rows: rowsA_prod } = await pool.query(
      `SELECT _raw_data->>'name' AS name FROM "${SCHEMA_A}"."products" WHERE id = $1`,
      [product.id]
    )
    expect(rowsA_prod[0]?.name).toBe(newProductName)
    console.log(`  SCHEMA_A.products  ✓  ${product.id} → "${newProductName}"`)

    // 16. Verify product in SCHEMA_B (same event, different destination — fan-out)
    const { rows: rowsB_prod } = await pool.query(
      `SELECT _raw_data->>'name' AS name FROM "${SCHEMA_B}"."products" WHERE id = $1`,
      [product.id]
    )
    expect(rowsB_prod[0]?.name).toBe(newProductName)
    console.log(`  SCHEMA_B.products  ✓  ${product.id} → "${newProductName}"`)

    // 17. Verify customer in SCHEMA_B (sync B has customers in catalog)
    const { rows: rowsB_cust } = await pool.query(
      `SELECT _raw_data->>'name' AS name FROM "${SCHEMA_B}"."customers" WHERE id = $1`,
      [customer.id]
    )
    expect(rowsB_cust[0]?.name).toBe(newCustomerName)
    console.log(`  SCHEMA_B.customers ✓  ${customer.id} → "${newCustomerName}"`)

    // 18. Verify customer NOT in SCHEMA_A (sync A filtered it — customers not in catalog)
    const { rows: tablesA } = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename = 'customers'`,
      [SCHEMA_A]
    )
    expect(tablesA).toHaveLength(0)
    console.log(`  SCHEMA_A.customers ✓  (not in sync A catalog — filtered out)`)
  }, 120_000)
})
