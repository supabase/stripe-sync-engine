import { execSync } from 'child_process'
import { resolve } from 'path'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import source from '@stripe/source-stripe'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STRIPE_MOCK_URL = process.env.STRIPE_MOCK_URL ?? 'http://localhost:12111'
const CLI_PATH = resolve(import.meta.dirname, '../../dist/cli/index.js')
const SCHEMA = 'test_stripe_pg'

// ---------------------------------------------------------------------------
// Docker Postgres lifecycle
// ---------------------------------------------------------------------------

let containerId: string
let pool: pg.Pool
let connectionString: string

beforeAll(async () => {
  // Guard: skip if stripe-mock is not reachable
  try {
    execSync(`curl -sf ${STRIPE_MOCK_URL}`, { timeout: 5_000 })
  } catch {
    console.warn(`stripe-mock not reachable at ${STRIPE_MOCK_URL} — skipping`)
    return
  }

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

beforeEach(async () => {
  if (!pool) return
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cli(command: string, params: Record<string, unknown>): string {
  return execSync(`node ${CLI_PATH} ${command} --params '${JSON.stringify(params)}'`, {
    encoding: 'utf8',
    timeout: 120_000,
  })
}

function makeParams(
  overrides: Partial<{
    source_name: string
    destination_name: string
    source_config: Record<string, unknown>
    destination_config: Record<string, unknown>
    streams: Array<{ name: string; sync_mode?: string }>
    state: Record<string, unknown>
  }> = {}
) {
  return {
    source_name: 'stripe',
    destination_name: 'postgres',
    source_config: { api_key: 'sk_test_fake', base_url: STRIPE_MOCK_URL },
    destination_config: { connection_string: connectionString, schema: SCHEMA },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Discover a valid stream name from stripe-mock
// ---------------------------------------------------------------------------

let targetStream: string

beforeAll(async () => {
  if (!pool) return
  const discovered = await source.discover({
    config: { api_key: 'sk_test_fake', base_url: STRIPE_MOCK_URL },
    catalog: { streams: [] },
    state: {},
  })
  targetStream = discovered.streams[0]!.stream.name
}, 30_000)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('selective sync', () => {
  it('syncs only the requested stream — other tables not created', async () => {
    if (!pool) return

    cli('run', makeParams({ streams: [{ name: targetStream }] }))

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
    if (!pool) return

    cli(
      'run',
      makeParams({
        streams: [{ name: targetStream }],
        state: { [targetStream]: { pageCursor: null, status: 'complete' } },
      })
    )

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

describe('cli stdin/stdout', () => {
  it('read command outputs valid NDJSON to stdout', async () => {
    if (!pool) return

    const output = cli('read', makeParams({ streams: [{ name: targetStream }] }))

    // Each line is valid JSON
    const lines = output.trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    const messages = lines.map((line) => JSON.parse(line))

    // Contains record and state messages
    const records = messages.filter((m: { type: string }) => m.type === 'record')
    const states = messages.filter((m: { type: string }) => m.type === 'state')
    expect(records.length).toBeGreaterThan(0)
    expect(states.length).toBeGreaterThan(0)

    // Records have required fields
    for (const r of records) {
      expect(r.stream).toBe(targetStream)
      expect(r.data).toBeDefined()
      expect(r.data.id).toBeDefined()
    }
  })

  it('read | write pipe: read output feeds into write stdin', async () => {
    if (!pool) return

    const params = makeParams({ streams: [{ name: targetStream }] })
    const paramsJson = JSON.stringify(params)

    // Setup first (creates tables)
    cli('setup', params)

    // Pipe: read → write
    const output = execSync(
      `node ${CLI_PATH} read --params '${paramsJson}' | node ${CLI_PATH} write --params '${paramsJson}'`,
      { encoding: 'utf8', timeout: 120_000, shell: '/bin/bash' }
    )

    // write outputs state messages as NDJSON
    const lines = output.trim().split('\n').filter(Boolean)
    const states = lines.map((l) => JSON.parse(l))
    expect(states.length).toBeGreaterThan(0)
    expect(states.every((s: { type: string }) => s.type === 'state')).toBe(true)

    // Records landed in Postgres
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM "${SCHEMA}"."${targetStream}"`
    )
    expect(rows[0].n).toBeGreaterThan(0)
  })
})
