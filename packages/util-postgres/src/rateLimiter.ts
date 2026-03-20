import type pg from 'pg'

export type RateLimiterOptions = {
  /** Unique key identifying this rate limit bucket (e.g. "stripe:sk_live_xxx"). */
  key: string
  /** Max requests per second (also the burst capacity — one second's worth). */
  max_rps: number
  /** Schema for the _rate_limit_buckets table (default: none / public). */
  schema?: string
}

type Queryable = {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult>
}

const TABLE = '_rate_limit_buckets'

function qualifiedTable(schema: string | undefined): string {
  if (schema) return `"${schema}"."${TABLE}"`
  return `"${TABLE}"`
}

/**
 * Create the _rate_limit_buckets table if it doesn't exist.
 * Call once at startup.
 */
export async function createRateLimiterTable(client: Queryable, schema?: string): Promise<void> {
  const tbl = qualifiedTable(schema)
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${tbl} (
      key         TEXT PRIMARY KEY,
      tokens      DOUBLE PRECISION NOT NULL,
      last_refill TIMESTAMPTZ      NOT NULL DEFAULT now()
    )
  `)
}

/**
 * Acquire `cost` tokens from the bucket identified by `key`.
 *
 * Returns the number of seconds the caller should wait before proceeding.
 * - 0 means tokens were available immediately — proceed now.
 * - >0 means the bucket was empty; the caller should sleep this many seconds,
 *   then proceed (the tokens have already been reserved).
 *
 * ## How it works
 *
 * Internally this is a **token bucket** backed by a single postgres row per key.
 *
 * On every `acquire()` call:
 *
 * 1. **Lock** — take a transaction-scoped advisory lock on the key so concurrent
 *    workers serialize through this section.
 *
 * 2. **Refill** — compute how many request slots have accrued since last call:
 *    `elapsed_seconds * max_rps`, capped at `max_rps` (one second's worth).
 *
 * 3. **Deduct** — subtract `cost`. The balance can go negative, meaning we're
 *    "borrowing" against future refills.
 *
 * 4. **Return wait time** — if there were enough slots, return 0. Otherwise
 *    return `deficit / max_rps` — the seconds until enough slots refill.
 *
 * `acquire()` never rejects — it always reserves the slot and tells you how
 * long to wait. This makes the caller simple:
 *
 * ```ts
 * const wait = await acquire(pool, { key: 'stripe:sk_xxx', max_rps: 100 })
 * if (wait > 0) await sleep(wait * 1000)
 * // proceed with API call
 * ```
 *
 * ## Multi-worker coordination
 *
 * All workers sharing the same postgres database and key will serialize through
 * the advisory lock. The token count is the single source of truth — no
 * in-process state to drift.
 */
export async function acquire(
  client: Queryable,
  options: RateLimiterOptions,
  cost = 1
): Promise<number> {
  const { key, max_rps, schema } = options
  const tbl = qualifiedTable(schema)

  // Single atomic statement: lock → refill → deduct → return.
  //
  // The INSERT … SELECT … FROM lock forces the advisory lock to be acquired
  // before the upsert runs. The ON CONFLICT clause does refill + deduct in
  // one SET expression, so there's no window for concurrent writers to
  // interleave.
  //
  // RETURNING gives us `tokens` (post-deduct). Adding cost back yields the
  // pre-deduct level, which we use to compute the wait time.
  const { rows } = await client.query(
    `
    WITH lock AS (
      SELECT pg_advisory_xact_lock(hashtext($1))
    )
    INSERT INTO ${tbl} (key, tokens, last_refill)
    SELECT $1, $2::double precision - $4::double precision, now()
    FROM lock
    ON CONFLICT (key) DO UPDATE
      SET tokens = LEAST(
            $2::double precision,
            ${tbl}.tokens + EXTRACT(EPOCH FROM (now() - ${tbl}.last_refill)) * $3::double precision
          ) - $4::double precision,
          last_refill = now()
    RETURNING tokens
    `,
    [key, max_rps, max_rps, cost]
  )

  const afterDeduct = rows[0].tokens as number

  // after_deduct = before_deduct - cost
  // before_deduct = after_deduct + cost
  const beforeDeduct = afterDeduct + cost

  if (beforeDeduct >= cost) return 0

  // Deficit: how many tokens we're short. Wait for them to refill.
  const deficit = cost - beforeDeduct
  return deficit / max_rps
}
