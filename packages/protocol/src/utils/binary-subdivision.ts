/**
 * N-ary subdivision scheduler — a pure, self-replicating parallel time-range search.
 *
 * Algorithm:
 *   1. Start with one or more time ranges to search.
 *   2. Fetch one page from each range in parallel (rate limiter controls concurrency).
 *   3. Observe: record the last sort-key value seen in each page.
 *   4. Subdivide: split ranges that have a cursor into a boundary (keeps cursor)
 *      and N equal segments of the unfetched remainder.
 *   5. Repeat until no ranges remain.
 *
 * N=10 reaches full parallelism in 2 rounds instead of 7 (binary). The tradeoff
 * is up to N-1 wasted probes per split on skewed data, but with high rate limits
 * and 1-2s API latency the faster ramp-up dominates.
 *
 * See docs/architecture/binary-subdivision.md for complexity analysis.
 *
 * Pure subdivision functions are data in, data out, no I/O, no side effects.
 * `streamingSubdivide` is the async work-queue driver that wires them together.
 */

// MARK: - Types

/** A time range with an optional opaque pagination cursor. */
export type Range = {
  gte: string // ISO 8601, inclusive
  lt: string // ISO 8601, exclusive
  cursor: string | null // null = not yet started or completed
}

/** A bounded time interval. */
export type TimeBound = { gte: string; lt: string }

// MARK: - Time helpers

export function toUnixSeconds(iso: string): number {
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) throw new Error(`Invalid ISO date: ${JSON.stringify(iso)}`)
  return Math.floor(ms / 1000)
}

export function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

// MARK: - Subdivision

/** Default number of segments to split the older remainder into. */
export const DEFAULT_SUBDIVISION_FACTOR = 2

/**
 * Subdivide ranges that have a cursor (were in progress but didn't complete).
 *
 * Stripe list APIs return newest records first. After one page, the newer side
 * of the range is already fetched; the unfetched remainder is the older side,
 * plus the boundary second that may still have more rows after the current
 * cursor.
 *
 * N-ary subdivision: split the older remainder into `n` equal segments.
 * Reaches full parallelism in O(log_n M) rounds. Wastes at most n-1 empty
 * probes per split on skewed data.
 */
export function subdivideRanges(
  remaining: Range[],
  lastObserved: Map<Range, number>,
  n: number
): Range[] {
  const result: Range[] = []

  for (const range of remaining) {
    if (range.cursor === null || !lastObserved.has(range)) {
      result.push(range)
      continue
    }

    const splitPoint = lastObserved.get(range)!
    const rangeStartUnix = toUnixSeconds(range.gte)
    const rangeEndUnix = toUnixSeconds(range.lt)
    const olderEndUnix = splitPoint

    // Nothing older to split — keep paginating sequentially.
    if (olderEndUnix <= rangeStartUnix) {
      result.push(range)
      continue
    }

    // Boundary range: keeps the cursor to drain remaining records at this second.
    const boundaryGteUnix = Math.max(rangeStartUnix, splitPoint)
    const boundaryLtUnix = Math.min(rangeEndUnix, splitPoint + 1)
    result.push({ gte: toIso(boundaryGteUnix), lt: toIso(boundaryLtUnix), cursor: range.cursor })

    // Split the older remainder [rangeStart, splitPoint) into n equal segments.
    const span = olderEndUnix - rangeStartUnix
    if (span <= 1) {
      // Can't split a 1-second range further.
      result.push({ gte: toIso(rangeStartUnix), lt: toIso(olderEndUnix), cursor: null })
    } else {
      const segments = Math.min(n, span) // don't create more segments than seconds
      for (let i = 0; i < segments; i++) {
        const segGte = rangeStartUnix + Math.floor((span * i) / segments)
        const segLt = rangeStartUnix + Math.floor((span * (i + 1)) / segments)
        if (segLt > segGte) {
          result.push({ gte: toIso(segGte), lt: toIso(segLt), cursor: null })
        }
      }
    }
  }

  return result
}

// MARK: - Streaming work-queue

/** Result of fetching one page for a range. */
export type PageResult<T> = {
  range: Range
  data: T[]
  hasMore: boolean
  /** The oldest sort-key timestamp (unix seconds) seen on this page, if any. */
  lastObserved: number | null
}

/** Yielded by streamingSubdivide for each completed page. */
export type SubdivisionEvent<T> = {
  range: Range
  data: T[]
  hasMore: boolean
  /** Whether this range is fully exhausted (no more data, removed from queue). */
  exhausted: boolean
  /** Snapshot of all ranges still pending (in queue + in flight). For state checkpoints. */
  remaining: Range[]
}

/**
 * Streaming binary subdivision — processes ranges as a concurrent work-queue
 * instead of batched rounds. When any range's page completes, its children
 * are immediately enqueued rather than waiting for all ranges to finish.
 *
 * This keeps the pipeline full: fast-completing ranges (empty or boundary)
 * don't block on slow data-heavy ranges.
 *
 * The work-queue runs all fetches concurrently (up to the concurrency limit)
 * and pushes completed results into a buffer. The async generator yields
 * buffered results and awaits new ones — but crucially, in-flight fetches
 * keep running while the consumer processes results.
 *
 * @param initial   Starting ranges to process.
 * @param fetchPage Callback that fetches one page for a range. Must set
 *                  `range.cursor` if the page has more data.
 * @param concurrency Max parallel fetchPage calls.
 */
export async function* streamingSubdivide<T>(opts: {
  initial: Range[]
  fetchPage: (range: Range) => Promise<PageResult<T>>
  concurrency: number
  subdivisionFactor: number
}): AsyncGenerator<SubdivisionEvent<T>> {
  const { fetchPage, concurrency, subdivisionFactor } = opts
  const queue: Range[] = [...opts.initial]
  // Track ranges currently being fetched so we can report remaining state.
  const inflightRanges = new Map<number, Range>()

  // Each in-flight fetch resolves to a tagged result so Promise.race can
  // identify which one completed without re-wrapping every iteration.
  type Tagged = { id: number; result: PageResult<T> }
  const inflight = new Map<number, Promise<Tagged>>()
  let nextId = 0

  function launchNext(): boolean {
    if (queue.length === 0 || inflight.size >= concurrency) return false
    const range = queue.shift()!
    const id = nextId++
    inflightRanges.set(id, range)
    inflight.set(
      id,
      fetchPage(range).then((result) => ({ id, result }))
    )
    return true
  }

  /** Snapshot of all ranges not yet fully fetched (queued + in flight). */
  function snapshotRemaining(): Range[] {
    return [...inflightRanges.values(), ...queue]
  }

  // Fill up to concurrency
  while (launchNext()) {}

  while (inflight.size > 0) {
    // Wait for any one to finish
    const { id, result } = await Promise.race(inflight.values())
    inflight.delete(id)
    inflightRanges.delete(id)

    const { range, data, hasMore, lastObserved } = result

    if (data.length === 0 && !hasMore) {
      // Empty range — fully exhausted
    } else if (!hasMore) {
      // Range completed with data — no more pages
    } else if (lastObserved != null) {
      // Range has more data — subdivide and enqueue children
      const children = subdivideRanges([range], new Map([[range, lastObserved]]), subdivisionFactor)
      for (const child of children) queue.push(child)
    } else {
      // Has more but no lastObserved — re-enqueue to continue paginating
      queue.push(range)
    }

    // Launch new work BEFORE yielding so fetches run while consumer processes
    while (launchNext()) {}

    yield {
      range,
      data,
      hasMore,
      exhausted: !hasMore,
      remaining: snapshotRemaining(),
    }
  }
}
