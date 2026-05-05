import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import pg from 'pg'
import Stripe from 'stripe'
import sourceStripe from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'
import { createApp as createEngineApp, createConnectorResolver } from '@stripe/sync-engine'
import { createApp } from './app.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STRIPE_API_KEY = process.env['STRIPE_API_KEY']!
const POSTGRES_URL = process.env['POSTGRES_URL'] ?? process.env['DATABASE_URL']!
const SCHEMA = `simulate_webhook_${Date.now()}`
const SKIP_CLEANUP = process.env['SKIP_CLEANUP'] === '1'

// ---------------------------------------------------------------------------
// Setup: in-process engine + service, real Postgres, real Stripe
// No Temporal, no Docker.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let engineServer: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serviceServer: any
let serviceUrl: string
let pool: pg.Pool

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: POSTGRES_URL })
  await pool.query('SELECT 1')

  const resolver = await createConnectorResolver({
    sources: { stripe: sourceStripe },
    destinations: { postgres: destinationPostgres },
  })

  const engineApp = await createEngineApp(resolver)
  const engineUrl = await new Promise<string>((resolve) => {
    engineServer = serve(
      { fetch: engineApp.fetch, port: 0, serverOptions: { maxHeaderSize: 128 * 1024 } },
      (info) => resolve(`http://localhost:${(info as AddressInfo).port}`)
    )
  })

  const serviceApp = createApp({ resolver, engineUrl })
  serviceUrl = await new Promise<string>((resolve) => {
    serviceServer = serve({ fetch: serviceApp.fetch, port: 0 }, (info) =>
      resolve(`http://localhost:${(info as AddressInfo).port}`)
    )
  })

  console.log(`  Schema:   ${SCHEMA}`)
  console.log(`  Postgres: ${POSTGRES_URL}`)
  console.log(`  Engine:   ${engineUrl}`)
  console.log(`  Service:  ${serviceUrl}`)
}, 30_000)

afterAll(async () => {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('simulate_webhook_sync', () => {
  it('fetches events from Stripe and lands records in Postgres', async () => {
    const stripe = new Stripe(STRIPE_API_KEY)
    const createdAfter = Math.floor(Date.now() / 1000)

    // 1. Create a Stripe product so there's a known event to sync
    const product = await stripe.products.create({
      name: `simulate-webhook-sync-test-${Date.now()}`,
    })
    console.log(`\n  Created product: ${product.id}`)

    // 2. Create pipeline (skip connector check — we just need the config stored)
    const createRes = await fetch(`${serviceUrl}/pipelines?skip_check=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: {
          type: 'stripe',
          stripe: { api_key: STRIPE_API_KEY, api_version: '2025-03-31.basil' },
        },
        destination: {
          type: 'postgres',
          postgres: { url: POSTGRES_URL, schema: SCHEMA },
        },
        streams: [{ name: 'product' }],
      }),
    })
    expect(createRes.status).toBe(201)
    const pipeline = (await createRes.json()) as { id: string }
    const id = pipeline.id
    console.log(`  Pipeline: ${id}`)

    // 3. Setup destination tables
    const setupRes = await fetch(`${serviceUrl}/pipelines/${id}/setup?only=destination`, {
      method: 'POST',
    })
    expect(setupRes.status).toBe(200)
    await setupRes.text()

    // 4. Run simulate_webhook_sync scoped to events after product creation
    const syncRes = await fetch(
      `${serviceUrl}/pipelines/${id}/simulate_webhook_sync?created_after=${createdAfter}`,
      { method: 'POST' }
    )
    expect(syncRes.status).toBe(200)
    const syncBody = await syncRes.text()
    expect(syncBody).toContain('"type":"eof"')

    // 5. Assert the product row landed in Postgres
    const { rows } = await pool.query(`SELECT id FROM "${SCHEMA}"."product" WHERE id = $1`, [
      product.id,
    ])
    expect(rows).toHaveLength(1)
    console.log(`  Product ${product.id} found in Postgres ✓`)

    // Cleanup Stripe product
    await stripe.products.update(product.id, { active: false }).catch(() => {})
  }, 60_000)
})
