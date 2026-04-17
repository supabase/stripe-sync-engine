/**
 * A rate limiter returns the number of seconds the caller should wait
 * before proceeding.  0 means the token was available immediately.
 *
 * This contract matches `util-postgres`'s `acquire()` return value so a
 * Postgres-backed implementation can be used as a drop-in replacement.
 */
export type RateLimiter = (cost?: number) => Promise<number>

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
