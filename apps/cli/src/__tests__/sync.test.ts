import { execSync } from 'child_process'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createEngine } from '@stripe/sync-protocol'
import { PostgresDestination } from '@stripe/destination-postgres'
import type {
  CatalogMessage,
  Message,
  RecordMessage,
  Source,
  StateMessage,
  SyncConfig,
} from '@stripe/sync-protocol'

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
      return
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw new Error('Postgres did not become ready in time')
}, 60_000)

afterAll(async () => {
  await pool?.end()
  if (containerId) {
    execSync(`docker rm -f ${containerId}`)
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCHEMA = 'test_sync'
const STATE_TABLE = '_sync_state'

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item
  }
}

function record(stream: string, id: string, data?: Record<string, unknown>): RecordMessage {
  return {
    type: 'record',
    stream,
    data: { id, ...data },
    emitted_at: Date.now(),
  }
}

function state(stream: string, data: unknown): StateMessage {
  return { type: 'state', stream, data }
}

function createMockSource(messages: Message[]): {
  source: Source
  readSpy: ReturnType<typeof vi.fn>
} {
  const catalog: CatalogMessage = {
    type: 'catalog',
    streams: [{ name: 'customers', primary_key: [['id']] }],
  }
  const readSpy = vi.fn((): AsyncIterable<Message> => toAsync(messages))
  return {
    source: {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' as const }),
      discover: async () => catalog,
      read: readSpy,
    },
    readSpy,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sync lifecycle — run, checkpoint, resume', () => {
  beforeAll(async () => {
    // Create state table in its own schema
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."${STATE_TABLE}" (
        stream text PRIMARY KEY,
        data jsonb NOT NULL
      )
    `)
  })

  it('run 1: writes records and persists state', async () => {
    const { source, readSpy } = createMockSource([
      record('customers', 'cus_1', { name: 'Alice' }),
      record('customers', 'cus_2', { name: 'Bob' }),
      record('customers', 'cus_3', { name: 'Charlie' }),
      state('customers', { after: 'cus_3' }),
    ])

    const destination = new PostgresDestination({
      schema: SCHEMA,
      poolConfig: { connectionString },
    })

    const config: SyncConfig = {
      source_config: {},
      destination_config: { connectionString },
    }

    // Suppress engine stderr logging during test
    const engine = createEngine(config, { source, destination }, {})

    // Run pipeline, persist each state checkpoint to Postgres
    for await (const msg of engine.run()) {
      await pool.query(
        `INSERT INTO "${SCHEMA}"."${STATE_TABLE}" (stream, data)
         VALUES ($1, $2)
         ON CONFLICT (stream) DO UPDATE SET data = $2`,
        [msg.stream, JSON.stringify(msg.data)]
      )
    }

    // Verify records were written
    const { rows: customers } = await pool.query(
      `SELECT count(*)::int AS n FROM "${SCHEMA}".customers`
    )
    expect(customers[0].n).toBe(3)

    // Verify state was persisted
    const { rows: stateRows } = await pool.query(
      `SELECT data FROM "${SCHEMA}"."${STATE_TABLE}" WHERE stream = 'customers'`
    )
    expect(stateRows).toHaveLength(1)
    expect(stateRows[0].data).toEqual({ after: 'cus_3' })

    // Verify source.read() was called without state (first run)
    expect(readSpy).toHaveBeenCalledOnce()
    const callArgs = readSpy.mock.calls[0]![0]
    expect(callArgs.state).toBeUndefined()
  })

  it('run 2: resumes from persisted state', async () => {
    // Load state from Postgres
    const { rows } = await pool.query(`SELECT stream, data FROM "${SCHEMA}"."${STATE_TABLE}"`)
    const loadedState = Object.fromEntries(
      rows.map((r: { stream: string; data: unknown }) => [r.stream, r.data])
    )

    // New source emits 2 more records + updated state
    const { source, readSpy } = createMockSource([
      record('customers', 'cus_4', { name: 'Diana' }),
      record('customers', 'cus_5', { name: 'Eve' }),
      state('customers', { after: 'cus_5' }),
    ])

    const destination = new PostgresDestination({
      schema: SCHEMA,
      poolConfig: { connectionString },
    })

    const config: SyncConfig = {
      source_config: {},
      destination_config: { connectionString },
      state: loadedState,
    }

    const engine = createEngine(config, { source, destination }, {})

    for await (const msg of engine.run()) {
      await pool.query(
        `INSERT INTO "${SCHEMA}"."${STATE_TABLE}" (stream, data)
         VALUES ($1, $2)
         ON CONFLICT (stream) DO UPDATE SET data = $2`,
        [msg.stream, JSON.stringify(msg.data)]
      )
    }

    // Verify source.read() was called with the loaded state
    expect(readSpy).toHaveBeenCalledOnce()
    const callArgs = readSpy.mock.calls[0]![0]
    expect(callArgs.state).toEqual({ customers: { after: 'cus_3' } })

    // Verify table now has 5 rows total (3 from run 1 + 2 from run 2)
    const { rows: customers } = await pool.query(
      `SELECT count(*)::int AS n FROM "${SCHEMA}".customers`
    )
    expect(customers[0].n).toBe(5)

    // Verify state was updated
    const { rows: stateRows } = await pool.query(
      `SELECT data FROM "${SCHEMA}"."${STATE_TABLE}" WHERE stream = 'customers'`
    )
    expect(stateRows).toHaveLength(1)
    expect(stateRows[0].data).toEqual({ after: 'cus_5' })
  })
})
