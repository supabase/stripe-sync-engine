import pg from 'pg'
import Stripe from 'stripe'
import { afterAll, beforeAll, expect, it } from 'vitest'
import source from '@stripe/sync-source-stripe'
import destination from '@stripe/sync-destination-postgres'
import { createEngine } from '@stripe/sync-engine'
import type { ConnectorResolver } from '@stripe/sync-engine'
import type { StateMessage, DestinationOutput } from '@stripe/sync-protocol'
import { drain } from '@stripe/sync-protocol'
import { describeWithEnv } from './test-helpers.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const POSTGRES_URL =
  process.env.POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres'
const ts = new Date()
  .toISOString()
  .replace(/[-:T.Z]/g, '')
  .slice(0, 15)
const SCHEMA = `e2e_${ts}`
const STREAMS = ['products', 'prices']
const BACKFILL_LIMIT = 10

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectStates(iter: AsyncIterable<DestinationOutput>): Promise<StateMessage[]> {
  const states: StateMessage[] = []
  for await (const msg of iter) {
    if (msg.type === 'state') states.push(msg)
  }
  return states
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeWithEnv('stripe → postgres e2e', ['STRIPE_API_KEY'], ({ STRIPE_API_KEY }) => {
  let pool: pg.Pool
  let stripe: Stripe

  const resolver: ConnectorResolver = {
    resolveSource: async (name) => {
      if (name !== 'stripe') throw new Error(`Unknown source: ${name}`)
      return source
    },
    resolveDestination: async (name) => {
      if (name !== 'postgres') throw new Error(`Unknown destination: ${name}`)
      return destination
    },
    sources: () => new Map(),
    destinations: () => new Map(),
  }

  function makePipeline(opts: { websocket?: boolean } = {}) {
    return {
      source: {
        type: 'stripe',
        stripe: {
          api_key: STRIPE_API_KEY,
          backfill_limit: BACKFILL_LIMIT,
          backfill_concurrency: 1,
          ...(opts.websocket && { websocket: true }),
        },
      },
      destination: {
        type: 'postgres',
        postgres: { connection_string: POSTGRES_URL, schema: SCHEMA },
      },
      streams: STREAMS.map((name) => ({ name })),
    }
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: POSTGRES_URL })
    await pool.query('SELECT 1')
    stripe = new Stripe(STRIPE_API_KEY)
    const account = await stripe.accounts.retrieve()
    const isTest = STRIPE_API_KEY.startsWith('sk_test_')
    const dashPrefix = isTest ? 'dashboard.stripe.com/test' : 'dashboard.stripe.com'
    console.log(`\n  Stripe:   ${account.id} → https://${dashPrefix}/developers`)
    console.log(`  Postgres: ${POSTGRES_URL} (schema: ${SCHEMA})`)
  })

  afterAll(async () => {
    if (!pool) return
    console.log(`\n  Postgres: ${POSTGRES_URL} (schema: ${SCHEMA})`)
    if (!process.env.KEEP_TEST_DATA) {
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    }
    await pool.end()
  })
  // -- Backfill (no websocket — runs to natural completion) -----------------

  it('backfills product and price data to postgres', async () => {
    const engine = await createEngine(resolver)
    await drain(engine.pipeline_setup(makePipeline()))
    await collectStates(engine.pipeline_sync(makePipeline()))

    for (const stream of STREAMS) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."${stream}"`)
      expect(rows[0].n).toBeGreaterThan(0)
      console.log(`    ${stream}: ${rows[0].n} rows`)
    }
  })

  // -- Live update via WebSocket --------------------------------------------

  it('receives live product update via websocket', async () => {
    // Clean slate — drop and recreate via pipeline_setup
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)

    const engine = await createEngine(resolver)
    const pipeline = makePipeline({ websocket: true })
    await drain(engine.pipeline_setup(pipeline))
    const iter = engine.pipeline_sync(pipeline)[Symbol.asyncIterator]()

    try {
      // Phase 1: consume until backfill completes for all streams
      const completed = new Set<string>()
      while (completed.size < STREAMS.length) {
        const { value, done } = await iter.next()
        if (done) throw new Error('Pipeline ended before backfill completed')
        if (value.type === 'state' && (value.state.data as any)?.status === 'complete') {
          completed.add(value.state.stream)
        }
      }
      console.log('    Backfill complete, sending product update…')

      // Phase 2: update a product via Stripe API
      const products = await stripe.products.list({ limit: 1 })
      expect(products.data.length).toBeGreaterThan(0)
      const product = products.data[0]
      const newName = `e2e-test-${Date.now()}`
      await stripe.products.update(product.id, { name: newName })

      // Phase 3: consume until we see a live event state for product
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const result = await Promise.race([
          iter.next(),
          new Promise<{ timeout: true }>((resolve) =>
            setTimeout(() => resolve({ timeout: true }), 30_000)
          ),
        ])
        if ('timeout' in result) break
        const { value, done } = result as IteratorResult<DestinationOutput>
        if (done) break
        if (
          value.type === 'state' &&
          value.state.stream === 'products' &&
          (value.state.data as any)?.eventId
        )
          break
      }

      // Phase 4: verify the update landed in Postgres
      const { rows } = await pool.query(
        `SELECT _raw_data->>'name' AS name FROM "${SCHEMA}"."products" WHERE id = $1`,
        [product.id]
      )
      expect(rows[0].name).toBe(newName)
      console.log(`    Live update verified: ${product.id} → "${newName}"`)
    } finally {
      // Close the pipeline. The generator is paused at a yield point after
      // we consumed the last message, so return() triggers the finally block
      // in source.read() which closes the WebSocket.
      await Promise.race([
        iter.return!(undefined as any),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
  })
})
