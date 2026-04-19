import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { upsert, upsertWithStats } from './upsert.js'

// ---------------------------------------------------------------------------
// Postgres connection — requires DATABASE_URL or `docker compose up postgres`
// ---------------------------------------------------------------------------

let pool: pg.Pool

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required — run `docker compose up -d postgres` first')
  }
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  await pool.query('SELECT 1')
})

afterAll(async () => {
  // Drop tables created during this run
  const { rows } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE tablename LIKE 'test_upsert_%'`
  )
  for (const row of rows) {
    await pool.query(`DROP TABLE IF EXISTS "${row.tablename}"`)
  }
  await pool.end()
})

// ---------------------------------------------------------------------------
// Table setup — fresh table per test
// ---------------------------------------------------------------------------

const testRunId = Math.random().toString(36).slice(2, 8)
let tableSeq = 0

function nextTable() {
  return `test_upsert_${testRunId}_${++tableSeq}`
}

async function createTable(table: string, extra = ''): Promise<string> {
  await pool.query(`
    CREATE TABLE "${table}" (
      id text PRIMARY KEY,
      name text,
      score int
      ${extra ? ', ' + extra : ''}
    )
  `)
  return table
}

async function rows(table: string, orderBy = 'id') {
  const { rows } = await pool.query(`SELECT * FROM "${table}" ORDER BY "${orderBy}"`)
  return rows
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('basic insert', () => {
  let table: string
  beforeEach(async () => {
    table = await createTable(nextTable())
  })

  it('inserts a single row into an empty table', async () => {
    await upsert(pool, [{ id: '1', name: 'Alice', score: 100 }], {
      table,
      primaryKeyColumns: ['id'],
    })

    const r = await rows(table)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: '1', name: 'Alice', score: 100 })
  })

  it('returns inserted data with returning: true', async () => {
    const result = await upsert(pool, [{ id: '1', name: 'Alice', score: 100 }], {
      table,
      primaryKeyColumns: ['id'],
      returning: true,
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ id: '1', name: 'Alice', score: 100 })
  })
})

describe('basic update', () => {
  let table: string
  beforeEach(async () => {
    table = await createTable(nextTable())
    await upsert(pool, [{ id: '1', name: 'Alice', score: 100 }], {
      table,
      primaryKeyColumns: ['id'],
    })
  })

  it('updates an existing row on conflict', async () => {
    await upsert(pool, [{ id: '1', name: 'Alice Updated', score: 200 }], {
      table,
      primaryKeyColumns: ['id'],
    })

    const r = await rows(table)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: '1', name: 'Alice Updated', score: 200 })
  })
})

describe('no-op skip (IS DISTINCT FROM)', () => {
  let table: string
  beforeEach(async () => {
    table = await createTable(nextTable())
    await upsert(pool, [{ id: '1', name: 'Alice', score: 100 }], {
      table,
      primaryKeyColumns: ['id'],
    })
  })

  it('skips update when row is identical', async () => {
    const result = await upsert(pool, [{ id: '1', name: 'Alice', score: 100 }], {
      table,
      primaryKeyColumns: ['id'],
      returning: true,
    })

    // No rows returned because IS DISTINCT FROM filtered it out
    expect(result.rows).toHaveLength(0)
  })

  it('performs update when skipNoopUpdates is disabled', async () => {
    const result = await upsert(pool, [{ id: '1', name: 'Alice', score: 100 }], {
      table,
      primaryKeyColumns: ['id'],
      skipNoopUpdates: false,
      returning: true,
    })

    expect(result.rows).toHaveLength(1)
  })
})

describe('JSONB shallow merge', () => {
  let table: string
  beforeEach(async () => {
    table = nextTable()
    await pool.query(`
      CREATE TABLE "${table}" (
        id text PRIMARY KEY,
        meta jsonb
      )
    `)
  })

  it('merges new keys into existing jsonb', async () => {
    await upsert(pool, [{ id: '1', meta: { a: 1 } }], {
      table,
      primaryKeyColumns: ['id'],
      shallowMergeJsonbColumns: ['meta'],
    })

    await upsert(pool, [{ id: '1', meta: { b: 2 } }], {
      table,
      primaryKeyColumns: ['id'],
      shallowMergeJsonbColumns: ['meta'],
    })

    const r = await rows(table)
    expect(r[0].meta).toEqual({ a: 1, b: 2 })
  })

  it('preserves existing keys when new keys added', async () => {
    await upsert(pool, [{ id: '1', meta: { x: 'keep', y: 'keep' } }], {
      table,
      primaryKeyColumns: ['id'],
      shallowMergeJsonbColumns: ['meta'],
    })

    await upsert(pool, [{ id: '1', meta: { z: 'new' } }], {
      table,
      primaryKeyColumns: ['id'],
      shallowMergeJsonbColumns: ['meta'],
    })

    const r = await rows(table)
    expect(r[0].meta).toEqual({ x: 'keep', y: 'keep', z: 'new' })
  })

  it('handles NULL coalesce — first insert with no existing value', async () => {
    // Insert a row with NULL meta directly
    await pool.query(`INSERT INTO "${table}" (id, meta) VALUES ('1', NULL)`)

    // Upsert with shallow merge should work (COALESCE handles NULL)
    await upsert(pool, [{ id: '1', meta: { a: 1 } }], {
      table,
      primaryKeyColumns: ['id'],
      shallowMergeJsonbColumns: ['meta'],
    })

    const r = await rows(table)
    expect(r[0].meta).toEqual({ a: 1 })
  })
})

describe('insertOnlyColumns', () => {
  let table: string
  beforeEach(async () => {
    table = nextTable()
    await pool.query(`
      CREATE TABLE "${table}" (
        id text PRIMARY KEY,
        name text,
        created_at text
      )
    `)
  })

  it('sets created_at on insert, preserves it on update', async () => {
    await upsert(pool, [{ id: '1', name: 'Alice', created_at: '2024-01-01' }], {
      table,
      primaryKeyColumns: ['id'],
      insertOnlyColumns: ['created_at'],
    })

    await upsert(pool, [{ id: '1', name: 'Alice Updated', created_at: '2099-12-31' }], {
      table,
      primaryKeyColumns: ['id'],
      insertOnlyColumns: ['created_at'],
    })

    const r = await rows(table)
    expect(r[0]).toMatchObject({
      name: 'Alice Updated',
      created_at: '2024-01-01', // preserved from first insert
    })
  })
})

describe('volatileColumns', () => {
  let table: string
  beforeEach(async () => {
    table = nextTable()
    await pool.query(`
      CREATE TABLE "${table}" (
        id text PRIMARY KEY,
        name text,
        updated_at text
      )
    `)
  })

  it('change to noDiffColumn alone does not trigger update', async () => {
    await upsert(pool, [{ id: '1', name: 'Alice', updated_at: 't1' }], {
      table,
      primaryKeyColumns: ['id'],
      volatileColumns: ['updated_at'],
    })

    // Only updated_at changes — should be skipped by IS DISTINCT FROM
    const result = await upsert(pool, [{ id: '1', name: 'Alice', updated_at: 't2' }], {
      table,
      primaryKeyColumns: ['id'],
      volatileColumns: ['updated_at'],
      returning: true,
    })

    expect(result.rows).toHaveLength(0)

    const r = await rows(table)
    expect(r[0].updated_at).toBe('t1') // not changed
  })

  it('updates noDiffColumn when a real column also changes', async () => {
    await upsert(pool, [{ id: '1', name: 'Alice', updated_at: 't1' }], {
      table,
      primaryKeyColumns: ['id'],
      volatileColumns: ['updated_at'],
    })

    await upsert(pool, [{ id: '1', name: 'Bob', updated_at: 't2' }], {
      table,
      primaryKeyColumns: ['id'],
      volatileColumns: ['updated_at'],
    })

    const r = await rows(table)
    expect(r[0]).toMatchObject({ name: 'Bob', updated_at: 't2' })
  })
})

describe('guardColumns', () => {
  let table: string
  beforeEach(async () => {
    table = nextTable()
    await pool.query(`
      CREATE TABLE "${table}" (
        id text PRIMARY KEY,
        name text,
        version int
      )
    `)
  })

  it('updates when guard column matches', async () => {
    await upsert(pool, [{ id: '1', name: 'Alice', version: 1 }], {
      table,
      primaryKeyColumns: ['id'],
    })

    const result = await upsert(pool, [{ id: '1', name: 'Updated', version: 1 }], {
      table,
      primaryKeyColumns: ['id'],
      guardColumns: ['version'],
      skipNoopUpdates: false,
      returning: true,
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].name).toBe('Updated')
  })

  it('skips update when guard column does not match', async () => {
    await upsert(pool, [{ id: '1', name: 'Alice', version: 1 }], {
      table,
      primaryKeyColumns: ['id'],
    })

    const result = await upsert(pool, [{ id: '1', name: 'Should Not Apply', version: 999 }], {
      table,
      primaryKeyColumns: ['id'],
      guardColumns: ['version'],
      skipNoopUpdates: false,
      returning: true,
    })

    expect(result.rows).toHaveLength(0)

    const r = await rows(table)
    expect(r[0].name).toBe('Alice') // unchanged
  })
})

describe('composite keys', () => {
  let table: string
  beforeEach(async () => {
    table = nextTable()
    await pool.query(`
      CREATE TABLE "${table}" (
        account_id text,
        item_id text,
        value text,
        PRIMARY KEY (account_id, item_id)
      )
    `)
  })

  it('inserts with composite key', async () => {
    await upsert(pool, [{ account_id: 'a1', item_id: 'i1', value: 'hello' }], {
      table,
      primaryKeyColumns: ['account_id', 'item_id'],
    })

    const r = await rows(table, 'account_id')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ account_id: 'a1', item_id: 'i1', value: 'hello' })
  })

  it('updates on composite key conflict', async () => {
    await upsert(pool, [{ account_id: 'a1', item_id: 'i1', value: 'v1' }], {
      table,
      primaryKeyColumns: ['account_id', 'item_id'],
    })

    await upsert(pool, [{ account_id: 'a1', item_id: 'i1', value: 'v2' }], {
      table,
      primaryKeyColumns: ['account_id', 'item_id'],
    })

    const r = await rows(table, 'account_id')
    expect(r).toHaveLength(1)
    expect(r[0].value).toBe('v2')
  })
})

describe('batch multi-row', () => {
  let table: string
  beforeEach(async () => {
    table = await createTable(nextTable())
  })

  it('inserts multiple rows in a single statement', async () => {
    await upsert(
      pool,
      [
        { id: '1', name: 'Alice', score: 100 },
        { id: '2', name: 'Bob', score: 200 },
        { id: '3', name: 'Charlie', score: 300 },
      ],
      { table, primaryKeyColumns: ['id'] }
    )

    const r = await rows(table)
    expect(r).toHaveLength(3)
  })

  it('handles mix of inserts and updates in one batch', async () => {
    await upsert(
      pool,
      [
        { id: '1', name: 'Alice', score: 100 },
        { id: '2', name: 'Bob', score: 200 },
      ],
      { table, primaryKeyColumns: ['id'] }
    )

    const result = await upsert(
      pool,
      [
        { id: '2', name: 'Bob Updated', score: 250 }, // update
        { id: '3', name: 'Charlie', score: 300 }, // insert
      ],
      { table, primaryKeyColumns: ['id'], returning: true }
    )

    // Both rows returned (one updated, one inserted)
    expect(result.rows).toHaveLength(2)

    const r = await rows(table)
    expect(r).toHaveLength(3)
    expect(r.find((x: any) => x.id === '2').name).toBe('Bob Updated')
    expect(r.find((x: any) => x.id === '3').name).toBe('Charlie')
  })
})

describe('NULL handling', () => {
  let table: string
  beforeEach(async () => {
    table = await createTable(nextTable())
  })

  it('inserts NULL values', async () => {
    await upsert(pool, [{ id: '1', name: null, score: null }], {
      table,
      primaryKeyColumns: ['id'],
    })

    const r = await rows(table)
    expect(r[0]).toMatchObject({ id: '1', name: null, score: null })
  })

  it('NULL IS DISTINCT FROM non-NULL triggers update', async () => {
    await upsert(pool, [{ id: '1', name: null, score: 100 }], {
      table,
      primaryKeyColumns: ['id'],
    })

    const result = await upsert(pool, [{ id: '1', name: 'Alice', score: 100 }], {
      table,
      primaryKeyColumns: ['id'],
      returning: true,
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].name).toBe('Alice')
  })

  it('NULL-to-NULL is a no-op', async () => {
    await upsert(pool, [{ id: '1', name: null, score: 100 }], {
      table,
      primaryKeyColumns: ['id'],
    })

    const result = await upsert(pool, [{ id: '1', name: null, score: 100 }], {
      table,
      primaryKeyColumns: ['id'],
      returning: true,
    })

    expect(result.rows).toHaveLength(0) // skipped — no change
  })
})

describe('newerThanColumn', () => {
  let table: string
  beforeEach(async () => {
    table = nextTable()
    await pool.query(`
      CREATE TABLE "${table}" (
        id text PRIMARY KEY,
        name text,
        updated int
      )
    `)
  })

  it('updates when incoming row is newer', async () => {
    await upsert(pool, [{ id: '1', name: 'Alice', updated: 100 }], {
      table,
      primaryKeyColumns: ['id'],
    })

    await upsert(pool, [{ id: '1', name: 'Alice v2', updated: 200 }], {
      table,
      primaryKeyColumns: ['id'],
      newerThanColumn: 'updated',
    })

    const r = await rows(table)
    expect(r[0]).toMatchObject({ id: '1', name: 'Alice v2', updated: 200 })
  })

  it('skips update when incoming row is older', async () => {
    await upsert(pool, [{ id: '1', name: 'Alice v2', updated: 200 }], {
      table,
      primaryKeyColumns: ['id'],
    })

    const result = await upsert(pool, [{ id: '1', name: 'Stale', updated: 100 }], {
      table,
      primaryKeyColumns: ['id'],
      newerThanColumn: 'updated',
      returning: true,
    })

    expect(result.rows).toHaveLength(0) // skipped — stale

    const r = await rows(table)
    expect(r[0]).toMatchObject({ id: '1', name: 'Alice v2', updated: 200 }) // unchanged
  })

  it('skips update when incoming row has equal timestamp', async () => {
    await upsert(pool, [{ id: '1', name: 'Alice', updated: 100 }], {
      table,
      primaryKeyColumns: ['id'],
    })

    const result = await upsert(pool, [{ id: '1', name: 'Same time', updated: 100 }], {
      table,
      primaryKeyColumns: ['id'],
      newerThanColumn: 'updated',
      returning: true,
    })

    expect(result.rows).toHaveLength(0) // skipped — not strictly newer

    const r = await rows(table)
    expect(r[0].name).toBe('Alice') // unchanged
  })

  it('inserts normally when row does not exist', async () => {
    await upsert(pool, [{ id: '1', name: 'New', updated: 50 }], {
      table,
      primaryKeyColumns: ['id'],
      newerThanColumn: 'updated',
    })

    const r = await rows(table)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: '1', name: 'New', updated: 50 })
  })
})

describe('newerThanColumn with GENERATED STORED column', () => {
  let table: string
  beforeEach(async () => {
    table = nextTable()
    await pool.query(`
      CREATE TABLE "${table}" (
        _raw_data jsonb NOT NULL,
        id text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
        created bigint GENERATED ALWAYS AS ((NULLIF(_raw_data->>'created', ''))::bigint) STORED,
        PRIMARY KEY (id)
      )
    `)
  })

  it('updates when incoming row is newer', async () => {
    await upsert(pool, [{ _raw_data: { id: '1', name: 'Alice', created: 100 } }], {
      table,
      primaryKeyColumns: ['id'],
    })

    await upsert(pool, [{ _raw_data: { id: '1', name: 'Alice v2', created: 200 } }], {
      table,
      primaryKeyColumns: ['id'],
      newerThanColumn: 'created',
    })

    const r = await rows(table)
    expect(r[0]).toMatchObject({ id: '1', created: '200' })
    expect(r[0]._raw_data.name).toBe('Alice v2')
  })

  it('skips update when incoming row is older', async () => {
    await upsert(pool, [{ _raw_data: { id: '1', name: 'Alice v2', created: 200 } }], {
      table,
      primaryKeyColumns: ['id'],
    })

    const result = await upsert(pool, [{ _raw_data: { id: '1', name: 'Stale', created: 100 } }], {
      table,
      primaryKeyColumns: ['id'],
      newerThanColumn: 'created',
      returning: true,
    })

    expect(result.rows).toHaveLength(0)

    const r = await rows(table)
    expect(r[0]._raw_data.name).toBe('Alice v2')
  })

  it('inserts normally when row does not exist', async () => {
    await upsert(pool, [{ _raw_data: { id: '1', name: 'New', created: 50 } }], {
      table,
      primaryKeyColumns: ['id'],
      newerThanColumn: 'created',
    })

    const r = await rows(table)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: '1', created: '50' })
    expect(r[0]._raw_data.name).toBe('New')
  })
})

// ---------------------------------------------------------------------------
// upsertWithStats
// ---------------------------------------------------------------------------

describe('upsertWithStats', () => {
  let table: string

  describe('basic counts', () => {
    beforeEach(async () => {
      table = await createTable(nextTable())
    })

    it('reports all inserts for new rows', async () => {
      const result = await upsertWithStats(
        pool,
        [
          { id: '1', name: 'Alice', score: 100 },
          { id: '2', name: 'Bob', score: 200 },
          { id: '3', name: 'Charlie', score: 300 },
        ],
        { table, primaryKeyColumns: ['id'] }
      )

      expect(result).toEqual({ created_count: 3, updated_count: 0, deleted_count: 0, skipped_count: 0 })
    })

    it('reports all updates when data changed', async () => {
      await upsert(
        pool,
        [
          { id: '1', name: 'Alice', score: 100 },
          { id: '2', name: 'Bob', score: 200 },
        ],
        { table, primaryKeyColumns: ['id'] }
      )

      const result = await upsertWithStats(
        pool,
        [
          { id: '1', name: 'Alice v2', score: 150 },
          { id: '2', name: 'Bob v2', score: 250 },
        ],
        { table, primaryKeyColumns: ['id'] }
      )

      expect(result).toEqual({ created_count: 0, updated_count: 2, deleted_count: 0, skipped_count: 0 })
    })

    it('reports all skipped when data is identical', async () => {
      await upsert(
        pool,
        [
          { id: '1', name: 'Alice', score: 100 },
          { id: '2', name: 'Bob', score: 200 },
        ],
        { table, primaryKeyColumns: ['id'] }
      )

      const result = await upsertWithStats(
        pool,
        [
          { id: '1', name: 'Alice', score: 100 },
          { id: '2', name: 'Bob', score: 200 },
        ],
        { table, primaryKeyColumns: ['id'] }
      )

      expect(result).toEqual({ created_count: 0, updated_count: 0, deleted_count: 0, skipped_count: 2 })
    })

    it('reports mixed inserts and updates', async () => {
      await upsert(pool, [{ id: '1', name: 'Alice', score: 100 }], {
        table,
        primaryKeyColumns: ['id'],
      })

      const result = await upsertWithStats(
        pool,
        [
          { id: '1', name: 'Alice v2', score: 150 }, // update
          { id: '2', name: 'Bob', score: 200 }, // insert
          { id: '3', name: 'Charlie', score: 300 }, // insert
        ],
        { table, primaryKeyColumns: ['id'] }
      )

      expect(result).toEqual({ created_count: 2, updated_count: 1, deleted_count: 0, skipped_count: 0 })
    })

    it('reports mixed inserts, updates, and skips', async () => {
      await upsert(
        pool,
        [
          { id: '1', name: 'Alice', score: 100 },
          { id: '2', name: 'Bob', score: 200 },
        ],
        { table, primaryKeyColumns: ['id'] }
      )

      const result = await upsertWithStats(
        pool,
        [
          { id: '1', name: 'Alice', score: 100 }, // skip (identical)
          { id: '2', name: 'Bob v2', score: 250 }, // update
          { id: '3', name: 'Charlie', score: 300 }, // insert
        ],
        { table, primaryKeyColumns: ['id'] }
      )

      expect(result).toEqual({ created_count: 1, updated_count: 1, deleted_count: 0, skipped_count: 1 })
    })

    it('returns zeros for empty records array', async () => {
      const result = await upsertWithStats(pool, [], { table, primaryKeyColumns: ['id'] })
      expect(result).toEqual({ created_count: 0, updated_count: 0, deleted_count: 0, skipped_count: 0 })
    })
  })

  describe('soft delete', () => {
    beforeEach(async () => {
      table = nextTable()
      await pool.query(`
        CREATE TABLE "${table}" (
          _raw_data jsonb NOT NULL,
          id text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED,
          PRIMARY KEY (id)
        )
      `)
    })

    it('classifies soft-deleted inserts as deleted', async () => {
      const result = await upsertWithStats(
        pool,
        [
          { _raw_data: { id: '1', name: 'Alice' } },
          { _raw_data: { id: '2', name: 'Bob' } },
          { _raw_data: { id: '3', name: 'Gone', deleted: true } },
        ],
        { table, primaryKeyColumns: ['id'], softDeleteExpression: "_raw_data->>'deleted'" }
      )

      expect(result).toEqual({ created_count: 2, updated_count: 0, deleted_count: 1, skipped_count: 0 })
    })

    it('classifies soft-deleted updates as deleted', async () => {
      await upsert(pool, [{ _raw_data: { id: '1', name: 'Alice' } }], {
        table,
        primaryKeyColumns: ['id'],
      })

      const result = await upsertWithStats(
        pool,
        [{ _raw_data: { id: '1', name: 'Alice', deleted: true } }],
        { table, primaryKeyColumns: ['id'], softDeleteExpression: "_raw_data->>'deleted'" }
      )

      expect(result).toEqual({ created_count: 0, updated_count: 0, deleted_count: 1, skipped_count: 0 })
    })
  })
})
