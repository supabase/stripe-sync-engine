import { execSync } from 'child_process'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import source from '@stripe/sync-source-stripe'
import destination from '@stripe/sync-destination-postgres'
import { createEngine, noopStateStore, selectStateStore } from '../lib/index.js'
import type { Message, DestinationOutput } from '../lib/index.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STRIPE_MOCK_URL = process.env.STRIPE_MOCK_URL ?? 'http://localhost:12111'
const SCHEMA = 'test_stripe_pg'

// ---------------------------------------------------------------------------
// Docker Postgres lifecycle
// ---------------------------------------------------------------------------

let containerId: string
let pool: pg.Pool
let connectionString: string

beforeAll(async () => {
  containerId = execSync(
    'docker run -d --rm -p 0:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test postgres:16-alpine',
    { encoding: 'utf8' }
  ).trim()

  const hostPort = execSync(`docker port ${containerId} 5432`, {
    encoding: 'utf8',
  })
    .trim()
    .split(':')
    .pop()

  connectionString = `postgresql://postgres:test@localhost:${hostPort}/test`
  pool = new pg.Pool({ connectionString })

  // Wait for Postgres to accept connections
  for (let i = 0; i < 30; i++) {
    try {
      await pool.query('SELECT 1')
      break
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (i === 29) throw new Error('Postgres did not become ready in time')
  }

  // Create the trigger function that destination-postgres expects
  await pool.query(`
    CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW := jsonb_populate_record(NEW, jsonb_build_object('updated_at', now(), '_updated_at', now()));
      RETURN NEW;
    END;
    $$;
  `)

  console.log(`\n  Postgres: ${connectionString}`)
}, 60_000)

afterAll(async () => {
  await pool?.end()
  if (containerId && !process.env.KEEP_TEST_DATA) {
    execSync(`docker rm -f ${containerId}`)
  }
})

beforeEach(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEngine(
  overrides: { streams?: Array<{ name: string }>; state?: Record<string, unknown> } = {}
) {
  return createEngine(
    {
      source: { name: 'stripe', api_key: 'sk_test_fake', base_url: STRIPE_MOCK_URL },
      destination: { name: 'postgres', connection_string: connectionString, schema: SCHEMA },
      streams: overrides.streams,
      state: overrides.state,
    },
    { source, destination },
    noopStateStore()
  )
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) items.push(item)
  return items
}

// ---------------------------------------------------------------------------
// Discover a valid stream name from stripe-mock
// ---------------------------------------------------------------------------

let targetStream: string

beforeAll(async () => {
  const discovered = await source.discover({
    config: { api_key: 'sk_test_fake', base_url: STRIPE_MOCK_URL },
    catalog: { streams: [] },
    state: {},
  })
  targetStream = discovered.streams[0]!.name
}, 30_000)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('selective sync', () => {
  it('syncs only the requested stream — other tables not created', async () => {
    const engine = makeEngine({ streams: [{ name: targetStream }] })
    await collect(engine.sync())

    // Only target table exists
    const { rows: tables } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [SCHEMA]
    )
    expect(tables.map((r: { table_name: string }) => r.table_name)).toContain(targetStream)
    expect(tables).toHaveLength(1)

    // Records were written
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM "${SCHEMA}"."${targetStream}"`
    )
    expect(rows[0].n).toBeGreaterThan(0)
  })
})

describe('selective backfill', () => {
  it('creates table but skips backfill when state is pre-seeded as complete', async () => {
    const engine = makeEngine({
      streams: [{ name: targetStream }],
      state: { [targetStream]: { pageCursor: null, status: 'complete' } },
    })
    await collect(engine.sync())

    // Table WAS created by setup()
    const { rows: tables } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [SCHEMA]
    )
    expect(tables.map((r: { table_name: string }) => r.table_name)).toContain(targetStream)

    // No backfill data
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM "${SCHEMA}"."${targetStream}"`
    )
    expect(rows[0].n).toBe(0)
  })
})

describe('engine read → write', () => {
  it('read returns records and state messages', async () => {
    const engine = makeEngine({ streams: [{ name: targetStream }] })
    const messages = await collect<Message>(engine.read())

    const records = messages.filter((m) => m.type === 'record')
    const states = messages.filter((m) => m.type === 'state')
    expect(records.length).toBeGreaterThan(0)
    expect(states.length).toBeGreaterThan(0)

    for (const r of records) {
      expect(r.stream).toBe(targetStream)
      expect((r as any).data).toBeDefined()
      expect((r as any).data.id).toBeDefined()
    }
  })

  it('read | write: read output piped through write stores data', async () => {
    const engine = makeEngine({ streams: [{ name: targetStream }] })

    // Setup first (creates tables)
    await engine.setup()

    // Read → collect → feed into write
    const readMessages = await collect<Message>(engine.read())
    async function* toAsync<T>(arr: T[]): AsyncGenerator<T> {
      for (const item of arr) yield item
    }
    const writeOutput = await collect<DestinationOutput>(engine.write(toAsync(readMessages)))
    const stateMessages = writeOutput.filter((s) => s.type === 'state')

    expect(stateMessages.length).toBeGreaterThan(0)

    // Records landed in Postgres
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM "${SCHEMA}"."${targetStream}"`
    )
    expect(rows[0].n).toBeGreaterThan(0)
  })
})

describe('resumable sync via state store', () => {
  const params = {
    source: { name: 'stripe', api_key: 'sk_test_fake', base_url: STRIPE_MOCK_URL },
    destination: { name: 'postgres', connection_string: '', schema: SCHEMA },
    streams: [{ name: '' }],
  }

  // Keep params.destination.connection_string and streams in sync with runtime values
  beforeAll(() => {
    // connectionString is set in the outer beforeAll — access it after that runs
  })

  beforeEach(async () => {
    // Outer beforeEach already dropped the schema. Create the _sync_state table in addition
    // to what the engine's setup() will create for the stream table.
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."_sync_state" (
        sync_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (sync_id, stream)
      )
    `)
  })

  it('auto-persists state after sync', async () => {
    const store = await selectStateStore({
      ...params,
      destination: { name: 'postgres', connection_string: connectionString, schema: SCHEMA },
      streams: [{ name: targetStream }],
    })
    const engine = createEngine(
      {
        source: { name: 'stripe', api_key: 'sk_test_fake', base_url: STRIPE_MOCK_URL },
        destination: { name: 'postgres', connection_string: connectionString, schema: SCHEMA },
        streams: [{ name: targetStream }],
      },
      { source, destination },
      store
    )
    await collect(engine.sync())
    expect(await store.get()).toMatchObject({ [targetStream]: expect.any(Object) })
    await store.close?.()
  })

  it('pre-seeded complete state skips backfill', async () => {
    const store = await selectStateStore({
      ...params,
      destination: { name: 'postgres', connection_string: connectionString, schema: SCHEMA },
      streams: [{ name: targetStream }],
    })
    await store.set(targetStream, { pageCursor: null, status: 'complete' })

    const engine = createEngine(
      {
        source: { name: 'stripe', api_key: 'sk_test_fake', base_url: STRIPE_MOCK_URL },
        destination: { name: 'postgres', connection_string: connectionString, schema: SCHEMA },
        streams: [{ name: targetStream }],
      },
      { source, destination },
      store
    )
    await collect(engine.sync())

    // Table created by setup() but no records written (backfill skipped by complete state)
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM "${SCHEMA}"."${targetStream}"`
    )
    expect(rows[0].n).toBe(0)
    await store.close?.()
  })
})
