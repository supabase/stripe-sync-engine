import { execSync } from 'child_process'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEngine } from '../lib/index.js'
import type { ConnectorResolver } from '../lib/index.js'
import { sourceTest } from '../lib/index.js'
import destination from '@stripe/sync-destination-postgres'
import type { RecordMessage, SourceStateMessage } from '../lib/index.js'

// ---------------------------------------------------------------------------
// Docker Postgres lifecycle
// ---------------------------------------------------------------------------

let containerId: string
let pool: pg.Pool
let connectionString: string
const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined)
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

beforeAll(async () => {
  containerId = execSync(
    [
      'docker run -d --rm -p 0:5432',
      '-e POSTGRES_PASSWORD=test -e POSTGRES_DB=test',
      'postgres:18',
      '-c ssl=on',
      '-c ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem',
      '-c ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key',
    ].join(' '),
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

beforeEach(() => {
  consoleInfo.mockClear()
  consoleError.mockClear()
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
    record: {
      stream,
      data: { id, ...data },
      emitted_at: new Date().toISOString(),
    },
  }
}

function state(stream: string, data: unknown): SourceStateMessage {
  return { type: 'source_state', source_state: { stream, data } }
}

function makeResolver(): ConnectorResolver {
  return {
    resolveSource: async (name) => {
      if (name !== 'test') throw new Error(`Unknown source: ${name}`)
      return sourceTest
    },
    resolveDestination: async (name) => {
      if (name !== 'postgres') throw new Error(`Unknown destination: ${name}`)
      return destination
    },
    sources: () => new Map(),
    destinations: () => new Map(),
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
    const engine = await createEngine(makeResolver())
    const pipeline = {
      source: { type: 'test', test: { streams: { customers: {} } } },
      destination: {
        type: 'postgres',
        postgres: { connection_string: connectionString, schema: SCHEMA },
      },
    }

    const input = [
      record('customers', 'cus_1', { name: 'Alice' }),
      record('customers', 'cus_2', { name: 'Bob' }),
      record('customers', 'cus_3', { name: 'Charlie' }),
      state('customers', { after: 'cus_3' }),
    ]

    // Set up destination schema/tables, then run pipeline
    for await (const _ of engine.pipeline_setup(pipeline)) {
    }
    for await (const msg of engine.pipeline_sync(pipeline, undefined, toAsync(input))) {
      if (msg.type === 'source_state') {
        await pool.query(
          `INSERT INTO "${SCHEMA}"."${STATE_TABLE}" (stream, data)
           VALUES ($1, $2)
           ON CONFLICT (stream) DO UPDATE SET data = $2`,
          [msg.source_state.stream, JSON.stringify(msg.source_state.data)]
        )
      }
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
  })

  it('run 2: resumes from persisted state', async () => {
    // Load state from Postgres
    const { rows } = await pool.query(`SELECT stream, data FROM "${SCHEMA}"."${STATE_TABLE}"`)
    const loadedState = Object.fromEntries(
      rows.map((r: { stream: string; data: unknown }) => [r.stream, r.data])
    )

    const engine = await createEngine(makeResolver())
    const pipeline = {
      source: { type: 'test', test: { streams: { customers: {} } } },
      destination: {
        type: 'postgres',
        postgres: { connection_string: connectionString, schema: SCHEMA },
      },
    }

    const input = [
      record('customers', 'cus_4', { name: 'Diana' }),
      record('customers', 'cus_5', { name: 'Eve' }),
      state('customers', { after: 'cus_5' }),
    ]

    for await (const msg of engine.pipeline_sync(
      pipeline,
      { state: loadedState },
      toAsync(input)
    )) {
      if (msg.type === 'source_state') {
        await pool.query(
          `INSERT INTO "${SCHEMA}"."${STATE_TABLE}" (stream, data)
           VALUES ($1, $2)
           ON CONFLICT (stream) DO UPDATE SET data = $2`,
          [msg.source_state.stream, JSON.stringify(msg.source_state.data)]
        )
      }
    }

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
