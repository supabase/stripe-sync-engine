import { execSync } from 'child_process'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import destination, { upsertMany, type Config } from './index.js'
import type {
  ConfiguredCatalog,
  DestinationInput,
  DestinationOutput,
  RecordMessage,
  StateMessage,
} from '@stripe/sync-protocol'
import { collectConnectionStatus, drainStream } from '@stripe/sync-protocol'

// ---------------------------------------------------------------------------
// Docker Postgres lifecycle
// ---------------------------------------------------------------------------

let containerId: string
let pool: pg.Pool
let connectionString: string

const SCHEMA = 'test_dest'

function makeConfig(): Config {
  return { connection_string: connectionString, schema: SCHEMA, port: 5432, batch_size: 100 }
}

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
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(stream: string, data: Record<string, unknown>): RecordMessage {
  return { type: 'record', record: { stream, data, emitted_at: new Date().toISOString() } }
}

function makeState(stream: string, data: unknown): StateMessage {
  return { type: 'state', state: { stream, data } }
}

async function* toAsyncIter(msgs: DestinationInput[]): AsyncIterable<DestinationInput> {
  for (const msg of msgs) {
    yield msg
  }
}

async function collectOutputs(
  iter: AsyncIterable<DestinationOutput>
): Promise<DestinationOutput[]> {
  const results: DestinationOutput[] = []
  for await (const msg of iter) {
    results.push(msg)
  }
  return results
}

const catalog: ConfiguredCatalog = {
  streams: [
    {
      stream: { name: 'customers', primary_key: [['id']], metadata: {} },
      sync_mode: 'full_refresh',
      destination_sync_mode: 'overwrite',
    },
  ],
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('destination default export', () => {
  describe('check()', () => {
    it('succeeds against a live Postgres', async () => {
      const { connection_status } = await collectConnectionStatus(
        destination.check({ config: makeConfig() })
      )
      expect(connection_status.status).toBe('succeeded')
    })

    it('fails with bad connection string', async () => {
      const { connection_status } = await collectConnectionStatus(
        destination.check({
          config: { ...makeConfig(), connection_string: 'postgresql://localhost:1/nope' },
        })
      )
      expect(connection_status.status).toBe('failed')
    })
  })

  describe('setup()', () => {
    it('creates schema and table', async () => {
      await drainStream(destination.setup!({ config: makeConfig(), catalog }))

      const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
        [SCHEMA]
      )
      expect(rows.map((r) => r.table_name)).toContain('customers')
    })
  })

  describe('teardown()', () => {
    it('drops schema CASCADE', async () => {
      await drainStream(destination.setup!({ config: makeConfig(), catalog }))
      await drainStream(destination.teardown!({ config: makeConfig() }))

      const { rows } = await pool.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
        [SCHEMA]
      )
      expect(rows).toHaveLength(0)
    })
  })

  describe('write()', () => {
    beforeEach(async () => {
      await drainStream(destination.setup!({ config: makeConfig(), catalog }))
    })

    it('upserts records and emits log on completion', async () => {
      const messages = toAsyncIter([
        makeRecord('customers', { id: 'cus_1', name: 'Alice' }),
        makeRecord('customers', { id: 'cus_2', name: 'Bob' }),
      ])

      const outputs = await collectOutputs(
        destination.write({ config: makeConfig(), catalog }, messages)
      )

      // Verify records in DB
      const { rows } = await pool.query(`SELECT id FROM "${SCHEMA}".customers ORDER BY id`)
      expect(rows.map((r) => r.id)).toEqual(['cus_1', 'cus_2'])

      // Should emit a log message
      const logs = outputs.filter((m) => m.type === 'log')
      expect(logs).toHaveLength(1)
    })

    it('batches inserts with configurable batch size', async () => {
      const config = { ...makeConfig(), batch_size: 2 }
      const messages = toAsyncIter([
        makeRecord('customers', { id: 'cus_1' }),
        makeRecord('customers', { id: 'cus_2' }),
        makeRecord('customers', { id: 'cus_3' }),
        makeRecord('customers', { id: 'cus_4' }),
        makeRecord('customers', { id: 'cus_5' }),
      ])

      await collectOutputs(destination.write({ config, catalog }, messages))

      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customers`)
      expect(rows[0].n).toBe(5)
    })

    it('re-emits StateMessage after flushing preceding records', async () => {
      const stateData = { cursor: 'abc123' }
      const messages = toAsyncIter([
        makeRecord('customers', { id: 'cus_1', name: 'Alice' }),
        makeRecord('customers', { id: 'cus_2', name: 'Bob' }),
        makeState('customers', stateData),
      ])

      const outputs = await collectOutputs(
        destination.write({ config: makeConfig(), catalog }, messages)
      )

      const stateOutputs = outputs.filter((m) => m.type === 'state')
      expect(stateOutputs).toHaveLength(1)
      expect(stateOutputs[0]).toEqual({
        type: 'state',
        state: { stream: 'customers', data: stateData },
      })

      // Records should be in DB (flushed before state was yielded)
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customers`)
      expect(rows[0].n).toBe(2)
    })

    it('handles upsert (ON CONFLICT update)', async () => {
      const messages1 = toAsyncIter([makeRecord('customers', { id: 'cus_1', name: 'Alice' })])
      await collectOutputs(destination.write({ config: makeConfig(), catalog }, messages1))

      const messages2 = toAsyncIter([
        makeRecord('customers', { id: 'cus_1', name: 'Alice Updated' }),
      ])
      await collectOutputs(destination.write({ config: makeConfig(), catalog }, messages2))

      const { rows } = await pool.query(
        `SELECT _raw_data->>'name' AS name FROM "${SCHEMA}".customers WHERE id = 'cus_1'`
      )
      expect(rows[0].name).toBe('Alice Updated')
    })
  })
})

describe('upsertMany standalone', () => {
  beforeEach(async () => {
    await drainStream(destination.setup!({ config: makeConfig(), catalog }))
  })

  it('inserts records directly via pool', async () => {
    const testPool = new pg.Pool({ connectionString })
    try {
      await upsertMany(testPool, SCHEMA, 'customers', [
        { id: 'cus_10', name: 'Direct' },
        { id: 'cus_11', name: 'Insert' },
      ])

      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customers`)
      expect(rows[0].n).toBe(2)
    } finally {
      await testPool.end()
    }
  })

  it('no-ops on empty array', async () => {
    const testPool = new pg.Pool({ connectionString })
    try {
      await upsertMany(testPool, SCHEMA, 'customers', [])
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customers`)
      expect(rows[0].n).toBe(0)
    } finally {
      await testPool.end()
    }
  })
})

describe('architecture purity', () => {
  it('destination never imports from or references any source module', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const srcDir = import.meta.dirname
    const srcFiles = fs.readdirSync(srcDir).filter((f: string) => f.endsWith('.ts'))

    for (const file of srcFiles) {
      const content = fs.readFileSync(path.join(srcDir, file), 'utf-8')
      expect(content).not.toMatch(/from\s+['"].*source-stripe/)
      expect(content).not.toMatch(/from\s+['"].*@stripe\/source-stripe/)
      expect(content).not.toMatch(/require\(['"].*source-stripe/)
    }
  })
})
