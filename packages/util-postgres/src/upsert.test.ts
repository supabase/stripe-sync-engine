import { execSync } from 'child_process'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { upsert } from './upsert.js'

// ---------------------------------------------------------------------------
// Docker Postgres lifecycle
// ---------------------------------------------------------------------------

let containerId: string
let pool: pg.Pool

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

  pool = new pg.Pool({
    connectionString: `postgresql://postgres:test@localhost:${hostPort}/test`,
  })

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
// Table setup — fresh table per test
// ---------------------------------------------------------------------------

let tableSeq = 0

function nextTable() {
  return `test_upsert_${++tableSeq}`
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
      keyColumns: ['id'],
    })

    const r = await rows(table)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ id: '1', name: 'Alice', score: 100 })
  })

  it('returns inserted data with returning: true', async () => {
    const result = await upsert(pool, [{ id: '1', name: 'Alice', score: 100 }], {
      table,
      keyColumns: ['id'],
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
      keyColumns: ['id'],
    })
  })

  it('updates an existing row on conflict', async () => {
    await upsert(pool, [{ id: '1', name: 'Alice Updated', score: 200 }], {
      table,
      keyColumns: ['id'],
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
      keyColumns: ['id'],
    })
  })

  it('skips update when row is identical', async () => {
    const result = await upsert(pool, [{ id: '1', name: 'Alice', score: 100 }], {
      table,
      keyColumns: ['id'],
      returning: true,
    })

    // No rows returned because IS DISTINCT FROM filtered it out
    expect(result.rows).toHaveLength(0)
  })

  it('performs update when skipNoopUpdates is disabled', async () => {
    const result = await upsert(pool, [{ id: '1', name: 'Alice', score: 100 }], {
      table,
      keyColumns: ['id'],
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
      keyColumns: ['id'],
      shallowMergeJsonbColumns: ['meta'],
    })

    await upsert(pool, [{ id: '1', meta: { b: 2 } }], {
      table,
      keyColumns: ['id'],
      shallowMergeJsonbColumns: ['meta'],
    })

    const r = await rows(table)
    expect(r[0].meta).toEqual({ a: 1, b: 2 })
  })

  it('preserves existing keys when new keys added', async () => {
    await upsert(pool, [{ id: '1', meta: { x: 'keep', y: 'keep' } }], {
      table,
      keyColumns: ['id'],
      shallowMergeJsonbColumns: ['meta'],
    })

    await upsert(pool, [{ id: '1', meta: { z: 'new' } }], {
      table,
      keyColumns: ['id'],
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
      keyColumns: ['id'],
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
      keyColumns: ['id'],
      insertOnlyColumns: ['created_at'],
    })

    await upsert(pool, [{ id: '1', name: 'Alice Updated', created_at: '2099-12-31' }], {
      table,
      keyColumns: ['id'],
      insertOnlyColumns: ['created_at'],
    })

    const r = await rows(table)
    expect(r[0]).toMatchObject({
      name: 'Alice Updated',
      created_at: '2024-01-01', // preserved from first insert
    })
  })
})

describe('noDiffColumns', () => {
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
      keyColumns: ['id'],
      noDiffColumns: ['updated_at'],
    })

    // Only updated_at changes — should be skipped by IS DISTINCT FROM
    const result = await upsert(pool, [{ id: '1', name: 'Alice', updated_at: 't2' }], {
      table,
      keyColumns: ['id'],
      noDiffColumns: ['updated_at'],
      returning: true,
    })

    expect(result.rows).toHaveLength(0)

    const r = await rows(table)
    expect(r[0].updated_at).toBe('t1') // not changed
  })

  it('updates noDiffColumn when a real column also changes', async () => {
    await upsert(pool, [{ id: '1', name: 'Alice', updated_at: 't1' }], {
      table,
      keyColumns: ['id'],
      noDiffColumns: ['updated_at'],
    })

    await upsert(pool, [{ id: '1', name: 'Bob', updated_at: 't2' }], {
      table,
      keyColumns: ['id'],
      noDiffColumns: ['updated_at'],
    })

    const r = await rows(table)
    expect(r[0]).toMatchObject({ name: 'Bob', updated_at: 't2' })
  })
})

describe('mustMatchColumns', () => {
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
      keyColumns: ['id'],
    })

    const result = await upsert(pool, [{ id: '1', name: 'Updated', version: 1 }], {
      table,
      keyColumns: ['id'],
      mustMatchColumns: ['version'],
      skipNoopUpdates: false,
      returning: true,
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].name).toBe('Updated')
  })

  it('skips update when guard column does not match', async () => {
    await upsert(pool, [{ id: '1', name: 'Alice', version: 1 }], {
      table,
      keyColumns: ['id'],
    })

    const result = await upsert(pool, [{ id: '1', name: 'Should Not Apply', version: 999 }], {
      table,
      keyColumns: ['id'],
      mustMatchColumns: ['version'],
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
      keyColumns: ['account_id', 'item_id'],
    })

    const r = await rows(table, 'account_id')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ account_id: 'a1', item_id: 'i1', value: 'hello' })
  })

  it('updates on composite key conflict', async () => {
    await upsert(pool, [{ account_id: 'a1', item_id: 'i1', value: 'v1' }], {
      table,
      keyColumns: ['account_id', 'item_id'],
    })

    await upsert(pool, [{ account_id: 'a1', item_id: 'i1', value: 'v2' }], {
      table,
      keyColumns: ['account_id', 'item_id'],
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
      { table, keyColumns: ['id'] }
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
      { table, keyColumns: ['id'] }
    )

    const result = await upsert(
      pool,
      [
        { id: '2', name: 'Bob Updated', score: 250 }, // update
        { id: '3', name: 'Charlie', score: 300 }, // insert
      ],
      { table, keyColumns: ['id'], returning: true }
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
      keyColumns: ['id'],
    })

    const r = await rows(table)
    expect(r[0]).toMatchObject({ id: '1', name: null, score: null })
  })

  it('NULL IS DISTINCT FROM non-NULL triggers update', async () => {
    await upsert(pool, [{ id: '1', name: null, score: 100 }], {
      table,
      keyColumns: ['id'],
    })

    const result = await upsert(pool, [{ id: '1', name: 'Alice', score: 100 }], {
      table,
      keyColumns: ['id'],
      returning: true,
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].name).toBe('Alice')
  })

  it('NULL-to-NULL is a no-op', async () => {
    await upsert(pool, [{ id: '1', name: null, score: 100 }], {
      table,
      keyColumns: ['id'],
    })

    const result = await upsert(pool, [{ id: '1', name: null, score: 100 }], {
      table,
      keyColumns: ['id'],
      returning: true,
    })

    expect(result.rows).toHaveLength(0) // skipped — no change
  })
})
