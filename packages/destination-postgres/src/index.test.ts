import { execSync } from 'child_process'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import destination, { deleteMany, upsertMany, writeMany, type Config } from './index.js'
import type {
  ConfiguredCatalog,
  DestinationInput,
  DestinationOutput,
  RecordMessage,
  SourceStateMessage,
} from '@stripe/sync-protocol'
import { collectFirst, drain } from '@stripe/sync-protocol'
import type { Message } from '@stripe/sync-protocol'

// ---------------------------------------------------------------------------
// Docker Postgres lifecycle
// ---------------------------------------------------------------------------

let containerId: string
let pool: pg.Pool
let connectionString: string

const SCHEMA = 'test_dest'

function makeConfig(): Config {
  return { url: connectionString, schema: SCHEMA, batch_size: 100 }
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
    .split('\n')[0]!
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

// Monotonically increasing seconds so consecutive `makeRecord` calls produce
// strictly-newer `_updated_at` values; the staleness gate rejects equal stamps.
let nextRecordTs = Math.floor(Date.now() / 1000)
function makeRecord(stream: string, data: Record<string, unknown>): RecordMessage {
  return {
    type: 'record',
    record: {
      stream,
      data: { _updated_at: nextRecordTs++, ...data },
      emitted_at: new Date().toISOString(),
    },
  }
}

function makeState(stream: string, data: unknown): SourceStateMessage {
  return { type: 'source_state', source_state: { stream, data } }
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
      stream: {
        name: 'customer',
        primary_key: [['id']],
        newer_than_field: '_updated_at',
        metadata: {},
      },
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
      const statusMsg = await collectFirst(
        destination.check({ config: makeConfig() }),
        'connection_status'
      )
      expect(statusMsg.connection_status.status).toBe('succeeded')
    })

    it('fails with bad connection string', async () => {
      await expect(
        collectFirst(
          destination.check({
            config: { ...makeConfig(), url: 'postgresql://localhost:1/nope' },
          }),
          'connection_status'
        )
      ).rejects.toThrow()
    })
  })

  describe('setup()', () => {
    it('creates schema and table', async () => {
      await drain(destination.setup!({ config: makeConfig(), catalog }))

      const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
        [SCHEMA]
      )
      expect(rows.map((r) => r.table_name)).toContain('customer')
    })
  })

  describe('teardown()', () => {
    it('drops schema CASCADE', async () => {
      await drain(destination.setup!({ config: makeConfig(), catalog }))
      await drain(destination.teardown!({ config: makeConfig() }))

      const { rows } = await pool.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
        [SCHEMA]
      )
      expect(rows).toHaveLength(0)
    })
  })

  describe('write()', () => {
    beforeEach(async () => {
      await drain(destination.setup!({ config: makeConfig(), catalog }))
    })

    it('upserts records and emits log on completion', async () => {
      const messages = toAsyncIter([
        makeRecord('customer', { id: 'cus_1', name: 'Alice' }),
        makeRecord('customer', { id: 'cus_2', name: 'Bob' }),
      ])

      const outputs = await collectOutputs(
        destination.write({ config: makeConfig(), catalog }, messages)
      )

      // Verify records in DB
      const { rows } = await pool.query(`SELECT id FROM "${SCHEMA}".customer ORDER BY id`)
      expect(rows.map((r) => r.id)).toEqual(['cus_1', 'cus_2'])

      // Log messages now go through pino, not the protocol stream
    })

    it('batches inserts with configurable batch size', async () => {
      const config = { ...makeConfig(), batch_size: 2 }
      const messages = toAsyncIter([
        makeRecord('customer', { id: 'cus_1' }),
        makeRecord('customer', { id: 'cus_2' }),
        makeRecord('customer', { id: 'cus_3' }),
        makeRecord('customer', { id: 'cus_4' }),
        makeRecord('customer', { id: 'cus_5' }),
      ])

      await collectOutputs(destination.write({ config, catalog }, messages))

      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customer`)
      expect(rows[0].n).toBe(5)
    })

    it('re-emits SourceStateMessage after flushing preceding records', async () => {
      const stateData = { cursor: 'abc123' }
      const messages = toAsyncIter([
        makeRecord('customer', { id: 'cus_1', name: 'Alice' }),
        makeRecord('customer', { id: 'cus_2', name: 'Bob' }),
        makeState('customer', stateData),
      ])

      const outputs = await collectOutputs(
        destination.write({ config: makeConfig(), catalog }, messages)
      )

      const stateOutputs = outputs.filter((m) => m.type === 'source_state')
      expect(stateOutputs).toHaveLength(1)
      expect(stateOutputs[0]).toEqual({
        type: 'source_state',
        source_state: { stream: 'customer', data: stateData },
      })

      // Records should be in DB (flushed before state was yielded)
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customer`)
      expect(rows[0].n).toBe(2)
    })

    it('handles upsert (ON CONFLICT update)', async () => {
      const messages1 = toAsyncIter([makeRecord('customer', { id: 'cus_1', name: 'Alice' })])
      await collectOutputs(destination.write({ config: makeConfig(), catalog }, messages1))

      const messages2 = toAsyncIter([
        makeRecord('customer', { id: 'cus_1', name: 'Alice Updated' }),
      ])
      await collectOutputs(destination.write({ config: makeConfig(), catalog }, messages2))

      const { rows } = await pool.query(
        `SELECT _raw_data->>'name' AS name FROM "${SCHEMA}".customer WHERE id = 'cus_1'`
      )
      expect(rows[0].name).toBe('Alice Updated')
    })
  })
})

describe('newer_than_field stale write prevention', () => {
  const newerThanCatalog: ConfiguredCatalog = {
    streams: [
      {
        stream: {
          name: 'customer',
          primary_key: [['id']],
          json_schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              updated: { type: 'integer' },
            },
          },
          newer_than_field: 'updated',
        },
        sync_mode: 'full_refresh',
        destination_sync_mode: 'overwrite',
      },
    ],
  }

  beforeEach(async () => {
    await drain(destination.setup!({ config: makeConfig(), catalog: newerThanCatalog }))
  })

  it('skips upsert when incoming record is older than existing', async () => {
    const batch1 = toAsyncIter([
      makeRecord('customer', { id: 'cus_1', name: 'Alice v2', updated: 200 }),
    ])
    await collectOutputs(
      destination.write({ config: makeConfig(), catalog: newerThanCatalog }, batch1)
    )

    const batch2 = toAsyncIter([
      makeRecord('customer', { id: 'cus_1', name: 'Alice v1 (stale)', updated: 100 }),
    ])
    await collectOutputs(
      destination.write({ config: makeConfig(), catalog: newerThanCatalog }, batch2)
    )

    const { rows } = await pool.query(
      `SELECT _raw_data->>'name' AS name, updated FROM "${SCHEMA}".customer WHERE id = 'cus_1'`
    )
    expect(rows[0].name).toBe('Alice v2')
    expect(rows[0].updated).toBe('200')
  })

  it('allows upsert when incoming record is newer than existing', async () => {
    const batch1 = toAsyncIter([
      makeRecord('customer', { id: 'cus_1', name: 'Alice v1', updated: 100 }),
    ])
    await collectOutputs(
      destination.write({ config: makeConfig(), catalog: newerThanCatalog }, batch1)
    )

    const batch2 = toAsyncIter([
      makeRecord('customer', { id: 'cus_1', name: 'Alice v2', updated: 200 }),
    ])
    await collectOutputs(
      destination.write({ config: makeConfig(), catalog: newerThanCatalog }, batch2)
    )

    const { rows } = await pool.query(
      `SELECT _raw_data->>'name' AS name, updated FROM "${SCHEMA}".customer WHERE id = 'cus_1'`
    )
    expect(rows[0].name).toBe('Alice v2')
    expect(rows[0].updated).toBe('200')
  })
})

describe('_updated_at column write-through', () => {
  // `_updated_at` is source time; `_synced_at` is destination write time.
  const updatedAtCatalog: ConfiguredCatalog = {
    streams: [
      {
        stream: { name: 'customer', primary_key: [['id']], newer_than_field: '_updated_at' },
        sync_mode: 'full_refresh',
        destination_sync_mode: 'overwrite',
      },
    ],
  }

  beforeEach(async () => {
    await drain(destination.setup!({ config: makeConfig(), catalog: updatedAtCatalog }))
  })

  it('writes source-stamped _updated_at into the timestamptz column', async () => {
    const ts = 1_700_000_000 // 2023-11-14T22:13:20Z
    const batch = toAsyncIter([
      makeRecord('customer', { id: 'cus_1', name: 'Alice', _updated_at: ts }),
    ])
    await collectOutputs(
      destination.write({ config: makeConfig(), catalog: updatedAtCatalog }, batch)
    )

    const { rows } = await pool.query<{
      raw: string
      column_ts: Date
      synced_at: Date
    }>(
      `SELECT _raw_data->>'_updated_at' AS raw, _updated_at AS column_ts, _synced_at AS synced_at
       FROM "${SCHEMA}".customer WHERE id = 'cus_1'`
    )
    expect(rows[0].raw).toBe(String(ts))
    // Column is timestamptz; verify the unix-seconds → Date conversion
    // landed on the exact second we asked for (no millisecond drift).
    expect(rows[0].column_ts.getTime()).toBe(ts * 1000)
    expect(rows[0].synced_at).toBeInstanceOf(Date)
  })

  it('updates _synced_at even if the record data has not changed', async () => {
    const ts = 1_700_000_000

    // First write
    await collectOutputs(
      destination.write(
        { config: makeConfig(), catalog: updatedAtCatalog },
        toAsyncIter([makeRecord('customer', { id: 'cus_1', name: 'Alice', _updated_at: ts })])
      )
    )

    const { rows: rows1 } = await pool.query<{ synced_at: Date }>(
      `SELECT _synced_at AS synced_at FROM "${SCHEMA}".customer WHERE id = 'cus_1'`
    )
    const firstSyncedAt = rows1[0].synced_at

    // Wait a tiny bit to ensure the timestamp will be distinctly different
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Second write with the EXACT same data (including the same _updated_at)
    await collectOutputs(
      destination.write(
        { config: makeConfig(), catalog: updatedAtCatalog },
        toAsyncIter([makeRecord('customer', { id: 'cus_1', name: 'Alice', _updated_at: ts })])
      )
    )

    const { rows: rows2 } = await pool.query<{ synced_at: Date }>(
      `SELECT _synced_at AS synced_at FROM "${SCHEMA}".customer WHERE id = 'cus_1'`
    )
    const secondSyncedAt = rows2[0].synced_at

    // _synced_at should be strictly newer, proving the row was updated
    expect(secondSyncedAt.getTime()).toBeGreaterThan(firstSyncedAt.getTime())
  })

  it('blocks stale writes via the _updated_at gate for objects without native updated', async () => {
    const newer = 1_700_000_200
    const older = 1_700_000_100

    await collectOutputs(
      destination.write(
        { config: makeConfig(), catalog: updatedAtCatalog },
        toAsyncIter([makeRecord('customer', { id: 'cus_1', name: 'Alice v2', _updated_at: newer })])
      )
    )
    await collectOutputs(
      destination.write(
        { config: makeConfig(), catalog: updatedAtCatalog },
        toAsyncIter([
          makeRecord('customer', {
            id: 'cus_1',
            name: 'Alice v1 (stale)',
            _updated_at: older,
          }),
        ])
      )
    )

    const { rows } = await pool.query<{ name: string; ts: Date }>(
      `SELECT _raw_data->>'name' AS name, _updated_at AS ts
       FROM "${SCHEMA}".customer WHERE id = 'cus_1'`
    )
    expect(rows[0].name).toBe('Alice v2')
    expect(rows[0].ts.getTime()).toBe(newer * 1000)
  })
})

describe('multi-org sync (two account IDs)', () => {
  const multiOrgCatalog: ConfiguredCatalog = {
    streams: [
      {
        stream: {
          name: 'customer',
          primary_key: [['id'], ['_account_id']],
          newer_than_field: '_updated_at',
          metadata: {},
          json_schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              _account_id: { type: 'string', enum: ['acct_AAA', 'acct_BBB'] },
            },
          },
        },
        sync_mode: 'full_refresh',
        destination_sync_mode: 'overwrite',
      },
    ],
  }

  beforeEach(async () => {
    await drain(destination.setup!({ config: makeConfig(), catalog: multiOrgCatalog }))
  })

  it('creates table with composite primary key (id, _account_id)', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'customer'
       ORDER BY ordinal_position`,
      [SCHEMA]
    )
    const columnNames = rows.map((r) => r.column_name)
    expect(columnNames).toContain('id')
    expect(columnNames).toContain('_account_id')

    const { rows: pkRows } = await pool.query(
      `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary
       ORDER BY array_position(i.indkey, a.attnum)`,
      [`"${SCHEMA}"."customer"`]
    )
    expect(pkRows.map((r) => r.attname)).toEqual(['id', '_account_id'])
  })

  it('stores rows from two accounts with the same object id as separate rows', async () => {
    const messages = toAsyncIter([
      makeRecord('customer', { id: 'cus_1', name: 'Alice (Acct A)', _account_id: 'acct_AAA' }),
      makeRecord('customer', { id: 'cus_1', name: 'Alice (Acct B)', _account_id: 'acct_BBB' }),
    ])

    await collectOutputs(
      destination.write({ config: makeConfig(), catalog: multiOrgCatalog }, messages)
    )

    const { rows } = await pool.query(
      `SELECT id, _account_id, _raw_data->>'name' AS name
       FROM "${SCHEMA}".customer ORDER BY _account_id`
    )
    expect(rows).toEqual([
      { id: 'cus_1', _account_id: 'acct_AAA', name: 'Alice (Acct A)' },
      { id: 'cus_1', _account_id: 'acct_BBB', name: 'Alice (Acct B)' },
    ])
  })

  it('upserts per-account: same id + same account updates, different account inserts', async () => {
    const batch1 = toAsyncIter([
      makeRecord('customer', { id: 'cus_1', name: 'Alice v1', _account_id: 'acct_AAA' }),
      makeRecord('customer', { id: 'cus_1', name: 'Alice v1', _account_id: 'acct_BBB' }),
    ])
    await collectOutputs(
      destination.write({ config: makeConfig(), catalog: multiOrgCatalog }, batch1)
    )

    const batch2 = toAsyncIter([
      makeRecord('customer', { id: 'cus_1', name: 'Alice v2', _account_id: 'acct_AAA' }),
    ])
    await collectOutputs(
      destination.write({ config: makeConfig(), catalog: multiOrgCatalog }, batch2)
    )

    const { rows } = await pool.query(
      `SELECT _account_id, _raw_data->>'name' AS name
       FROM "${SCHEMA}".customer ORDER BY _account_id`
    )
    expect(rows).toEqual([
      { _account_id: 'acct_AAA', name: 'Alice v2' },
      { _account_id: 'acct_BBB', name: 'Alice v1' },
    ])
  })
})

describe('upsertMany standalone', () => {
  beforeEach(async () => {
    await drain(destination.setup!({ config: makeConfig(), catalog }))
  })

  it('inserts records directly via pool', async () => {
    const testPool = new pg.Pool({ connectionString })
    try {
      const ts = Math.floor(Date.now() / 1000)
      await upsertMany(
        testPool,
        SCHEMA,
        'customer',
        [
          { id: 'cus_10', name: 'Direct', _updated_at: ts },
          { id: 'cus_11', name: 'Insert', _updated_at: ts },
        ],
        ['id'],
        '_updated_at'
      )

      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customer`)
      expect(rows[0].n).toBe(2)
    } finally {
      await testPool.end()
    }
  })

  it('no-ops on empty array', async () => {
    const testPool = new pg.Pool({ connectionString })
    try {
      await upsertMany(testPool, SCHEMA, 'customer', [], ['id'], '_updated_at')
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customer`)
      expect(rows[0].n).toBe(0)
    } finally {
      await testPool.end()
    }
  })
})

describe('deleteMany / writeMany', () => {
  beforeEach(async () => {
    await drain(destination.setup!({ config: makeConfig(), catalog }))
  })

  it('hard-deletes existing rows by primary key', async () => {
    const testPool = new pg.Pool({ connectionString })
    try {
      const ts = Math.floor(Date.now() / 1000)
      await upsertMany(
        testPool,
        SCHEMA,
        'customer',
        [
          { id: 'cus_keep', name: 'Keep', _updated_at: ts },
          { id: 'cus_drop', name: 'Drop', _updated_at: ts },
        ],
        ['id'],
        '_updated_at'
      )

      const result = await deleteMany(testPool, SCHEMA, 'customer', [{ id: 'cus_drop' }], ['id'])
      expect(result.deleted_count).toBe(1)

      const { rows } = await pool.query(`SELECT id FROM "${SCHEMA}".customer ORDER BY id`)
      expect(rows).toEqual([{ id: 'cus_keep' }])
    } finally {
      await testPool.end()
    }
  })

  it('deletes are terminal regardless of timestamp ordering', async () => {
    const testPool = new pg.Pool({ connectionString })
    try {
      const ts = Math.floor(Date.now() / 1000)
      await upsertMany(
        testPool,
        SCHEMA,
        'customer',
        [{ id: 'cus_fresh', name: 'Fresh', _updated_at: ts + 10 }],
        ['id'],
        '_updated_at'
      )

      const result = await deleteMany(testPool, SCHEMA, 'customer', [{ id: 'cus_fresh' }], ['id'])
      expect(result.deleted_count).toBe(1)

      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customer`)
      expect(rows[0].n).toBe(0)
    } finally {
      await testPool.end()
    }
  })

  it('writeMany routes a mixed batch to upsert and delete paths', async () => {
    const testPool = new pg.Pool({ connectionString })
    try {
      const ts = Math.floor(Date.now() / 1000)
      await upsertMany(
        testPool,
        SCHEMA,
        'customer',
        [{ id: 'cus_old', name: 'Old', _updated_at: ts }],
        ['id'],
        '_updated_at'
      )

      const result = await writeMany(
        testPool,
        SCHEMA,
        'customer',
        [
          { data: { id: 'cus_new', name: 'New', _updated_at: ts + 1 } },
          { recordDeleted: true, data: { id: 'cus_old', _updated_at: ts + 1 } },
        ],
        ['id'],
        '_updated_at'
      )
      expect(result.created_count).toBe(1)
      expect(result.deleted_count).toBe(1)

      const { rows } = await pool.query(`SELECT id FROM "${SCHEMA}".customer ORDER BY id`)
      expect(rows).toEqual([{ id: 'cus_new' }])
    } finally {
      await testPool.end()
    }
  })

  it('deleteMany no-ops on empty array', async () => {
    const testPool = new pg.Pool({ connectionString })
    try {
      const result = await deleteMany(testPool, SCHEMA, 'customer', [], ['id'])
      expect(result).toEqual({ deleted_count: 0 })
    } finally {
      await testPool.end()
    }
  })

  it('deletes only the matching tenant row for composite (id, _account_id) PK', async () => {
    const testPool = new pg.Pool({ connectionString })
    try {
      const compositeCatalog: ConfiguredCatalog = {
        streams: [
          {
            stream: {
              name: 'customer',
              primary_key: [['id'], ['_account_id']],
              newer_than_field: '_updated_at',
              json_schema: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  _account_id: { type: 'string' },
                },
              },
            },
            sync_mode: 'full_refresh',
            destination_sync_mode: 'overwrite',
          },
        ],
      }
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
      await drain(destination.setup!({ config: makeConfig(), catalog: compositeCatalog }))
      const ts = Math.floor(Date.now() / 1000)
      await upsertMany(
        testPool,
        SCHEMA,
        'customer',
        [
          { id: 'cus_1', name: 'Alice (A)', _account_id: 'acct_AAA', _updated_at: ts },
          { id: 'cus_1', name: 'Alice (B)', _account_id: 'acct_BBB', _updated_at: ts },
        ],
        ['id', '_account_id'],
        '_updated_at'
      )

      const result = await deleteMany(
        testPool,
        SCHEMA,
        'customer',
        [{ id: 'cus_1', _account_id: 'acct_AAA' }],
        ['id', '_account_id']
      )
      expect(result.deleted_count).toBe(1)

      const { rows } = await pool.query(
        `SELECT _account_id FROM "${SCHEMA}".customer ORDER BY _account_id`
      )
      expect(rows).toEqual([{ _account_id: 'acct_BBB' }])
    } finally {
      await testPool.end()
    }
  })
})

describe('schema-driven CHECK constraints', () => {
  function catalogWith(enumValues: string[], column = '_account_id'): ConfiguredCatalog {
    return {
      streams: [
        {
          stream: {
            name: 'charge',
            primary_key: [['id'], [column]],
            json_schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                [column]: { type: 'string', enum: enumValues },
              },
            },
          },
          sync_mode: 'full_refresh',
          destination_sync_mode: 'overwrite',
        },
      ],
    }
  }

  async function constraintDefs(table = 'charge'): Promise<string[]> {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'c'`,
      [SCHEMA, table]
    )
    return rows.map((r) => r.def as string)
  }

  it('enforces enum allow-list and rejects mismatched re-setups', async () => {
    await drain(
      destination.setup!({
        config: makeConfig(),
        catalog: catalogWith(['acct_a', 'acct_b']),
      })
    )
    await expect(
      pool.query(
        `INSERT INTO "${SCHEMA}".charge (_raw_data) VALUES ('{"id":"x","_account_id":"acct_other"}'::jsonb)`
      )
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      pool.query(`INSERT INTO "${SCHEMA}".charge (_raw_data) VALUES ('{"id":"missing"}'::jsonb)`)
    ).rejects.toMatchObject({ code: '23502' })
    await pool.query(
      `INSERT INTO "${SCHEMA}".charge (_raw_data) VALUES ('{"id":"a","_account_id":"acct_a"}'::jsonb)`
    )

    // Same allow-list re-runs cleanly (idempotent).
    await drain(
      destination.setup!({
        config: makeConfig(),
        catalog: catalogWith(['acct_b', 'acct_a']),
      })
    )

    // Narrower allow-list rejects: the constraint is pinned by name and
    // ADD CONSTRAINT would no-op via EXCEPTION WHEN duplicate_object, so
    // we fail loud instead of silently keeping the old predicate.
    await expect(
      drain(destination.setup!({ config: makeConfig(), catalog: catalogWith(['acct_a']) }))
    ).rejects.toThrow(
      /enum values changed.*charge.*_account_id.*acct_a, acct_b.*acct_a.*DROP CONSTRAINT/s
    )

    // After dropping the constraint manually, the next setup installs the new one.
    await pool.query(`ALTER TABLE "${SCHEMA}".charge DROP CONSTRAINT "chk_charge__account_id"`)
    await drain(destination.setup!({ config: makeConfig(), catalog: catalogWith(['acct_a']) }))
    const defs = await constraintDefs()
    expect(defs).toHaveLength(1)
    expect(defs[0]).toContain(`'acct_a'`)
    expect(defs[0]).not.toContain(`'acct_b'`)
    await expect(
      pool.query(
        `INSERT INTO "${SCHEMA}".charge (_raw_data) VALUES ('{"id":"b","_account_id":"acct_b"}'::jsonb)`
      )
    ).rejects.toMatchObject({ code: '23514' })
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
