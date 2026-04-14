/**
 * A rate limiter returns the number of seconds the caller should wait
 * before proceeding.  0 means the token was available immediately.
 *
 * This contract matches `util-postgres`'s `acquire()` return value so a
 * Postgres-backed implementation can be used as a drop-in replacement.
 */
export type RateLimiter = (cost?: number) => Promise<number>

// -- Backfill tuning constants ------------------------------------------------
// All three knobs live here so they're easy to find and reason about together.

/** Token-bucket refill rate. Each list API call costs 1 token. */
export const DEFAULT_MAX_RPS = 25

/**
 * Upper bound on how many time segments a single stream's backfill is split
 * into. More segments = finer time slices, but each one becomes its own
 * async generator so the overhead grows. 50 is high enough to saturate the
 * rate limit on dense streams without excessive per-segment bookkeeping.
 */
export const MAX_SEGMENTS = 50

/**
 * How many segment generators run concurrently inside `mergeAsync`.
 * Independent of MAX_SEGMENTS — a stream may be split into 50 segments but
 * only 15 are actively fetching pages at any moment. This bounds memory
 * pressure (each in-flight generator holds a partial page) and avoids
 * bursty traffic that the token-bucket would otherwise have to absorb.
 * 15 × ~2 pages/sec ≈ 30 RPS before the limiter starts throttling.
 */
export const MAX_CONCURRENCY = 15

/**
 * In-memory token-bucket rate limiter.
 *
 * Uses the same algorithm as the Postgres-backed limiter in `util-postgres`:
 * continuous proportional refill, tokens can go negative (borrowing against
 * future refills), and the caller gets back the exact wait time.
 */
export function createInMemoryRateLimiter(maxRps: number): RateLimiter {
  let tokens = maxRps
  let lastRefill = Date.now()

  return async (cost = 1) => {
    const elapsed = (Date.now() - lastRefill) / 1000
    tokens = Math.min(maxRps, tokens + elapsed * maxRps)
    lastRefill = Date.now()
    tokens -= cost
    if (tokens >= 0) return 0
    return -tokens / maxRps
  }
}
