/**
 * Sync Stripe → Google Sheets via the engine API (TypeScript).
 *
 * Usage:
 *   npx tsx demo/stripe-to-google-sheets.ts
 *   bun demo/stripe-to-google-sheets.ts
 *
 * Env: STRIPE_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 * Optional: GOOGLE_SPREADSHEET_ID (creates new sheet if omitted)
 */
import { createConnectorResolver, createEngine } from '../apps/engine/src/lib/index.js'
import { defaultConnectors } from '../apps/engine/src/lib/default-connectors.js'
import { fileStateStore } from '../apps/engine/src/lib/state-store.js'
import type { PipelineConfig } from '../packages/protocol/src/index.js'

const stripeApiKey = process.env.STRIPE_API_KEY
if (!stripeApiKey) throw new Error('Set STRIPE_API_KEY')

const pipeline: PipelineConfig = {
  source: { type: 'stripe', stripe: { api_key: stripeApiKey, backfill_limit: 10 } },
  destination: {
    type: 'google_sheets',
    google_sheets: {
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      access_token: 'unused',
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
      spreadsheet_id: process.env.GOOGLE_SPREADSHEET_ID,
      spreadsheet_title: 'Stripe Sync Demo',
      batch_size: 50,
    },
  },
  streams: [{ name: 'products' }, { name: 'customers' }],
}

const resolver = await createConnectorResolver(defaultConnectors, { path: true })
const engine = await createEngine(resolver)

// Setup (creates spreadsheet/sheets if needed)
for await (const _msg of engine.pipeline_setup(pipeline)) {}

// State: file-backed, resumable across runs
const store = fileStateStore('.sync-state-sheets.json')
const state = await store.get()

// Sync
for await (const msg of engine.pipeline_sync(pipeline, { state })) {
  if (msg.type === 'source_state') {
    if (msg.source_state.state_type === 'global') await store.setGlobal(msg.source_state.data)
    else await store.set(msg.source_state.stream, msg.source_state.data)
  }
  console.log(JSON.stringify(msg))
}
