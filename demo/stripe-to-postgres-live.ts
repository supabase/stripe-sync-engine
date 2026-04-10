/**
 * Sync Stripe → Postgres with live WebSocket streaming (TypeScript).
 *
 * After the initial backfill, the engine keeps running and streams live events
 * via Stripe's WebSocket API. Any changes in the Stripe Dashboard (or API)
 * appear in Postgres within seconds.
 *
 * Usage:
 *   node --import tsx demo/stripe-to-postgres-live.ts
 *
 * Trigger test events (in another terminal):
 *   stripe trigger customer.created
 *   stripe trigger product.created
 *
 * Env: STRIPE_API_KEY, DATABASE_URL (or POSTGRES_URL)
 */
import { createConnectorResolver, createEngine } from '../apps/engine/src/lib/index.js'
import { defaultConnectors } from '../apps/engine/src/lib/default-connectors.js'
import { fileStateStore } from '../apps/engine/src/lib/state-store.js'
import type { PipelineConfig } from '../packages/protocol/src/index.js'

const stripeApiKey = process.env.STRIPE_API_KEY
const postgresUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL
if (!stripeApiKey) throw new Error('Set STRIPE_API_KEY')
if (!postgresUrl) throw new Error('Set DATABASE_URL or POSTGRES_URL')

const pipeline: PipelineConfig = {
  source: {
    type: 'stripe',
    stripe: {
      api_key: stripeApiKey,
      backfill_limit: 10,
      websocket: true,
    },
  },
  destination: {
    type: 'postgres',
    postgres: { url: postgresUrl, schema: 'public', port: 5432, batch_size: 100 },
  },
  streams: [{ name: 'products' }, { name: 'prices' }, { name: 'customers' }],
}

const resolver = await createConnectorResolver(defaultConnectors, { path: true })
const engine = await createEngine(resolver)

// Create tables
for await (const _msg of engine.pipeline_setup(pipeline)) {
}

// State: file-backed, resumable across runs
const store = fileStateStore('.sync-state.json')
const state = await store.get()

console.error('=== Stripe → Postgres (live WebSocket mode) ===')
console.error('After backfill, the engine will stream live events. Press Ctrl+C to stop.\n')

// Sync — with websocket: true this blocks indefinitely, streaming live events
for await (const msg of engine.pipeline_sync(pipeline, { state })) {
  if (msg.type === 'source_state') {
    if (msg.source_state.state_type === 'global') await store.setGlobal(msg.source_state.data)
    else await store.set(msg.source_state.stream, msg.source_state.data)
  }
  console.log(JSON.stringify(msg))
}
