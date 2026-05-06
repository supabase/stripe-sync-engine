/**
 * Sync Stripe → Postgres via the engine API (TypeScript).
 *
 * Usage:
 *   npx tsx demo/stripe-to-postgres.ts
 *   bun demo/stripe-to-postgres.ts
 *
 * Env: STRIPE_API_KEY, DATABASE_URL (or POSTGRES_URL)
 */
import { createConnectorResolver, createEngine } from '../apps/engine/src/lib/index.js'
import { defaultConnectors } from '../apps/engine/src/lib/default-connectors.js'
import { fileStateStore } from '../apps/engine/src/lib/state-store.js'
import { type PipelineConfig, emptySyncState } from '../packages/protocol/src/index.js'

const stripeApiKey = process.env.STRIPE_API_KEY
const postgresUrl = process.env.DATABASE_URL ?? process.env.POSTGRES_URL
if (!stripeApiKey) throw new Error('Set STRIPE_API_KEY')
if (!postgresUrl) throw new Error('Set DATABASE_URL or POSTGRES_URL')

const pipeline: PipelineConfig = {
  source: { type: 'stripe', stripe: { api_key: stripeApiKey, backfill_limit: 10 } },
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
const sourceState = await store.get()
const state = sourceState ? { ...emptySyncState(), source: sourceState } : undefined

// Sync
for await (const msg of engine.pipeline_sync(pipeline, { state })) {
  if (msg.type === 'source_state') {
    if (msg.source_state.state_type === 'global') await store.setGlobal(msg.source_state.data)
    else await store.set(msg.source_state.stream, msg.source_state.data)
  }
  console.log(JSON.stringify(msg))
}
