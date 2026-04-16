import { execSync } from 'child_process'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { acquire, createRateLimiterTable } from './rateLimiter.js'

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
// Fresh table per describe block
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await pool.query('DROP TABLE IF EXISTS "_rate_limit_buckets"')
  await createRateLimiterTable(pool)
})

const opts = (max_rps = 10) => ({ key: 'test', max_rps })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('basic acquire', () => {
  it('first acquire returns 0 (budget available)', async () => {
    const wait = await acquire(pool, opts())
    expect(wait).toBe(0)
  })

  it('exceeding one second of budget returns positive wait times', async () => {
    // max_rps=3 means 3 requests available per second
    const o = opts(3)

    // First 3 should be instant
    expect(await acquire(pool, o)).toBe(0)
    expect(await acquire(pool, o)).toBe(0)
    expect(await acquire(pool, o)).toBe(0)

    // 4th exceeds budget — should return a positive wait
    const wait = await acquire(pool, o)
    expect(wait).toBeGreaterThan(0)
  })

  it('returns correct wait time proportional to deficit', async () => {
    // max_rps=100 means 1 slot per 10ms
    const o = opts(100)

    // First acquire uses one slot
    expect(await acquire(pool, o)).toBe(0)

    // Drain remaining 99 slots
    for (let i = 0; i < 99; i++) await acquire(pool, o)

    // Next acquire: deficit ≈ 1, wait ≈ 1/100 = 0.01s
    const wait = await acquire(pool, o)
    expect(wait).toBeCloseTo(0.01, 1)
  })
})

describe('cost parameter', () => {
  it('deducts multiple slots at once', async () => {
    const o = opts(5)

    // Acquire all 5 slots at once — should succeed
    expect(await acquire(pool, o, 5)).toBe(0)

    // Next acquire should require waiting
    const wait = await acquire(pool, o, 1)
    expect(wait).toBeGreaterThan(0)
  })

  it('large cost on empty budget returns proportional wait', async () => {
    const o = opts(10)

    // Drain the budget
    await acquire(pool, o, 10)

    // Ask for 5 more: deficit ≈ 5, wait ≈ 5/10 = 0.5s
    const wait = await acquire(pool, o, 5)
    expect(wait).toBeCloseTo(0.5, 1)
  })
})

describe('refill', () => {
  it('slots refill over time', async () => {
    const o = opts(10)

    // Use all 10 slots
    await acquire(pool, o, 10)

    // Next acquire should need waiting (budget empty)
    const wait1 = await acquire(pool, o)
    expect(wait1).toBeGreaterThan(0)

    // Wait long enough to refill (300ms at 10/s = 3 slots, covers the 1 borrowed above)
    await new Promise((r) => setTimeout(r, 300))

    // Should have enough slots back
    const wait2 = await acquire(pool, o)
    expect(wait2).toBe(0)
  })

  it('budget caps at max_rps (no unbounded accumulation)', async () => {
    // Use a very low rate so inter-call time doesn't refill meaningfully
    const o = opts(0.01)

    // First call creates the bucket. Initial budget = max_rps = 0.01.
    // A single acquire with cost=1 exceeds that — should need waiting.
    const wait = await acquire(pool, o)
    expect(wait).toBeGreaterThan(0)
  })
})

describe('multiple keys', () => {
  it('independent keys have independent budgets', async () => {
    const a = opts(1)
    const b = { ...a, key: 'other' }

    expect(await acquire(pool, a)).toBe(0)
    expect(await acquire(pool, b)).toBe(0)

    // a is drained, b is drained — independently
    const waitA = await acquire(pool, a)
    const waitB = await acquire(pool, b)
    expect(waitA).toBeGreaterThan(0)
    expect(waitB).toBeGreaterThan(0)
  })
})

describe('concurrent workers', () => {
  it('serializes through advisory lock — total budget respected', async () => {
    const o = opts(5) // 5 rps, near-zero time between calls

    // Fire 10 concurrent acquires — at most 5 should be instant
    const results = await Promise.all(Array.from({ length: 10 }, () => acquire(pool, o)))

    const instant = results.filter((w) => w === 0).length
    const waited = results.filter((w) => w > 0).length
    expect(instant).toBe(5)
    expect(waited).toBe(5)
  })
})

describe('schema support', () => {
  it('works with a custom schema', async () => {
    await pool.query('CREATE SCHEMA IF NOT EXISTS "custom"')
    await pool.query('DROP TABLE IF EXISTS "custom"."_rate_limit_buckets"')
    await createRateLimiterTable(pool, 'custom')

    const o = { ...opts(), schema: 'custom' }
    expect(await acquire(pool, o)).toBe(0)
  })
})
