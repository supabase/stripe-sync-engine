import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
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
const SCHEMA = `e2e_wh_${ts}`
const STREAM = 'products'

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

  // Postgres
  pool = new pg.Pool({ connectionString: POSTGRES_URL })
  await pool.query('SELECT 1')

  stripe = new Stripe(STRIPE_API_KEY)
  const account = await stripe.accounts.retrieve()
  const isTest = STRIPE_API_KEY.startsWith('sk_test_')
  const dashPrefix = isTest ? 'dashboard.stripe.com/test' : 'dashboard.stripe.com'
  console.log(`\n  Stripe:   ${account.id} → https://${dashPrefix}/developers`)
  console.log(`  Postgres: ${POSTGRES_URL} (schema: ${SCHEMA})`)

  // Start in-process stateful API with explicit connectors
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
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {})
    }
    await pool.end()
  }

  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
}, 30_000)

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.STRIPE_API_KEY)('stripe → postgres via webhook (stateful API)', () => {
  it('delivers a Stripe product update to a running sync via webhook fan-out', async () => {
    const base = `http://localhost:${apiPort}`

    // 1. Create Stripe credential (webhook_secret added after stripe listen starts)
    const srcCred = (await postJson(`${base}/credentials`, {
      type: 'stripe-api-core',
      api_key: STRIPE_API_KEY,
    })) as { id: string }

    // 2. Create Postgres credential
    await postJson(`${base}/credentials`, {
      type: 'postgres',
      connection_string: POSTGRES_URL,
    })
    // We don't need the postgres cred ID directly — just the sync body below
    const pgCredRes = await fetch(`${base}/credentials`)
    const { data: creds } = (await pgCredRes.json()) as { data: { id: string; type: string }[] }
    const pgCred = creds.find((c) => c.type === 'postgres')!

    // 3. Start stripe-cli via Docker, forward to this API's webhook ingress.
    //    On Linux, host.docker.internal needs --add-host to resolve to the host.
    //    On Mac (Docker Desktop), it's automatic — adding --add-host overrides it.
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

    // Capture the webhook signing secret from stripe-cli output.
    // Also pipe all stripe-cli output to stderr for test diagnostics.
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

    // After capturing the secret, keep forwarding stripe-cli output
    stripeListenProc!.stdout?.on('data', (d: Buffer) => process.stderr.write(`[stripe-cli] ${d}`))
    stripeListenProc!.stderr?.on('data', (d: Buffer) => process.stderr.write(`[stripe-cli] ${d}`))

    console.log(`  stripe-cli: forwarding to ${forwardTo}`)
    console.log(`  webhook secret: ${webhookSecret.slice(0, 14)}...`)

    // 4. Patch credential to add webhook_secret (needed for signature verification)
    await patchJson(`${base}/credentials/${srcCred.id}`, { webhook_secret: webhookSecret })

    // 5. Create sync — event-driven mode (no backfill, just processes $stdin events)
    const sync = (await postJson(`${base}/syncs`, {
      account_id: 'acct_test',
      status: 'syncing',
      source: {
        type: 'stripe-api-core',
        livemode: !STRIPE_API_KEY.startsWith('sk_test_'),
        api_version: '2025-04-30.basil',
        credential_id: srcCred.id,
      },
      destination: {
        type: 'postgres',
        schema: SCHEMA,
        credential_id: pgCred.id,
      },
      streams: [{ name: STREAM }],
    })) as { id: string }

    // 6. Start POST /syncs/:id/run — immediately enters event-driven mode
    //    (the stateful service creates an internal input queue and registers it
    //    under the credential_id; source.read($stdin) waits for pushed events)
    const ac = new AbortController()
    const runRes = await fetch(`${base}/syncs/${sync.id}/run`, {
      method: 'POST',
      signal: ac.signal,
    })
    expect(runRes.status).toBe(200)

    // Read stream in background, look for a state message with eventId
    let webhookProcessed = false
    const runErrors: string[] = []
    const streamDone = (async () => {
      const reader = runRes.body!.getReader()
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
              const msg = JSON.parse(line)
              if (msg.type === 'state' && msg.stream === STREAM && msg.data?.eventId) {
                webhookProcessed = true
              }
              if (msg.type === 'error') {
                runErrors.push(msg.message ?? JSON.stringify(msg))
              }
            } catch {}
          }
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') throw err
      } finally {
        reader.releaseLock()
      }
    })()

    // 7. Let the source settle at $stdin.next() before triggering the event.
    //    The stateful run() registers the input queue synchronously before
    //    any awaits, but we wait for destination.setup() (schema creation) to
    //    finish so the tables exist when the first record arrives.
    await new Promise((resolve) => setTimeout(resolve, 2_000))

    // 8. Trigger a Stripe product.updated event
    const products = await stripe.products.list({ limit: 1 })
    expect(products.data.length).toBeGreaterThan(0)
    const product = products.data[0]
    const newName = `e2e-wh-${Date.now()}`
    await stripe.products.update(product.id, { name: newName })
    console.log(`  Triggered update: ${product.id} → "${newName}"`)

    // 9. Wait for the webhook to arrive and be processed (up to 60s)
    const deadline = Date.now() + 60_000
    while (!webhookProcessed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    // 10. Stop the sync
    ac.abort()
    await streamDone

    if (runErrors.length) console.error('  sync errors:', runErrors)
    expect(webhookProcessed).toBe(true)

    // 11. Verify the update landed in Postgres
    const { rows } = await pool.query(
      `SELECT _raw_data->>'name' AS name FROM "${SCHEMA}"."${STREAM}" WHERE id = $1`,
      [product.id]
    )
    expect(rows[0]?.name).toBe(newName)
    console.log(`  Webhook verified: ${product.id} → "${newName}"`)
  }, 120_000)
})
