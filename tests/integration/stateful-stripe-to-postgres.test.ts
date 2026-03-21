import pg from 'pg'
import Stripe from 'stripe'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import source from '@stripe/source-stripe'
import destination from '@stripe/destination-postgres'
import { createConnectorResolver } from '@stripe/stateless-sync'
import type { StateMessage } from '@stripe/protocol'
import {
  StatefulSync,
  memoryCredentialStore,
  memoryConfigStore,
  stderrLogSink,
} from '@stripe/stateful-sync'
import { createPgStateStore, runMigrationsFromContent, migrations } from '@stripe/store-postgres'
import type { Credential } from '@stripe/stateful-sync'

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
const SCHEMA = `int_stateful_${ts}`
const STREAMS = ['products', 'prices']
const BACKFILL_LIMIT = 50

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let pool: pg.Pool
let stripe: Stripe

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: POSTGRES_URL })
  await pool.query('SELECT 1') // fail fast if Postgres is down

  await runMigrationsFromContent({ databaseUrl: POSTGRES_URL, schemaName: SCHEMA }, migrations)

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
    console.log(`  Cleaned up schema "${SCHEMA}"`)
  } else {
    console.log(`  KEEP_TEST_DATA set — schema "${SCHEMA}" preserved`)
  }
  await pool.end()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const connectors = createConnectorResolver({
  sources: { stripe: source },
  destinations: { postgres: destination },
})

function makeCred(id: string, type: string, extra: Record<string, unknown> = {}): Credential {
  return {
    id,
    type,
    ...extra,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function makeService() {
  const credentials = memoryCredentialStore({
    'pg-cred': makeCred('pg-cred', 'postgres', {
      connection_string: POSTGRES_URL,
    }),
  })

  // Source has no credential_id — api_key is inline in config.
  // This prevents StatefulSync from creating an infinite internal input queue
  // (which it does for credential-backed sources to support webhook fan-out).
  const configs = memoryConfigStore({
    'stripe-to-pg': {
      id: 'stripe-to-pg',
      source: {
        type: 'stripe',
        api_key: STRIPE_API_KEY,
        backfill_limit: BACKFILL_LIMIT,
      },
      destination: {
        type: 'postgres',
        credential_id: 'pg-cred',
        schema: SCHEMA,
      },
      streams: STREAMS.map((name) => ({ name })),
    },
  })

  const states = createPgStateStore(pool, SCHEMA)
  const logs = stderrLogSink()

  const service = new StatefulSync({
    credentials,
    configs,
    states,
    logs,
    connectors,
  })

  return { service, states }
}

async function collectStates(iter: AsyncIterable<StateMessage>): Promise<StateMessage[]> {
  const states: StateMessage[] = []
  for await (const msg of iter) states.push(msg)
  return states
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stateful stripe → postgres integration', () => {
  it('backfills through StatefulSync with memory stores + postgres destination', async () => {
    const { service } = makeService()
    const states = await collectStates(service.run('stripe-to-pg'))
    expect(states.length).toBeGreaterThan(0)

    for (const stream of STREAMS) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."${stream}"`)
      expect(rows[0].n).toBeGreaterThan(0)
      console.log(`    ${stream}: ${rows[0].n} rows`)
    }
  })

  it('resumes from persisted state on second run', async () => {
    // Use shared stores across both runs
    const { service, states: stateStore } = makeService()

    // Run 1
    await collectStates(service.run('stripe-to-pg'))
    const stateAfterRun1 = await stateStore.get('stripe-to-pg')
    expect(stateAfterRun1).toBeDefined()
    console.log('    State after run 1:', JSON.stringify(stateAfterRun1))

    // Count rows after first run
    const countsBefore: Record<string, number> = {}
    for (const stream of STREAMS) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."${stream}"`)
      countsBefore[stream] = rows[0].n
    }

    // Run 2 — same service (shared state store), should resume
    const states2 = await collectStates(service.run('stripe-to-pg'))
    console.log(`    Run 2 yielded ${states2.length} state messages`)

    // Rows should be same (upserted, not duplicated)
    for (const stream of STREAMS) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."${stream}"`)
      expect(rows[0].n).toBe(countsBefore[stream])
      console.log(`    ${stream}: ${rows[0].n} rows (unchanged)`)
    }
  })
})
