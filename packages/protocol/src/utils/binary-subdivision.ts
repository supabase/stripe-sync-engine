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
 * Subdivide an in-progress range (cursor set, one page fetched) into `n`
 * parallel children covering the unfetched older remainder.
 *
 * Stripe returns records newest-first; the page covered `[splitPoint, range.lt)`.
 * Split `[rangeStart, splitPoint)` into `n` equal segments; the top segment
 * widens its `lt` to `splitPoint + 1` and inherits the cursor so one request
 * drains the boundary second AND its older window via `starting_after` + a
 * widened `created` filter.
 *
 * Ranges with segment duration below 30s pass through unchanged so the cursor
 * paginates them sequentially instead of fanning out empty probes.
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
    const newEnd = lastObserved.get(range)!
    const start = toUnixSeconds(range.gte)

    if (newEnd <= start) {
      result.push(range)
      continue
    }

    const secondsLeft = newEnd - start
    const segments = Math.min(n, secondsLeft)
    const segmentDuration = Math.floor(secondsLeft / segments)
    if (segmentDuration < 30) {
      result.push(range)
      continue
    }

    for (let i = 0; i < segments; i++) {
      const segGte = start + segmentDuration * i
      const segLt = Math.min(newEnd, segGte + segmentDuration) // set a ceiling to newEnd
      const lastSegment = i === segments - 1
      if (lastSegment) {
        // handle the edge case where there are multiple objects created in a same second
        //  but our fetch didn't return all of them because of the limit of 100.
        result.push({ gte: toIso(segGte), lt: toIso(newEnd + 1), cursor: range.cursor })
      } else {
        result.push({ gte: toIso(segGte), lt: toIso(segLt), cursor: null })
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
    // Attach a no-op catch to prevent unhandled rejection when the generator
    // returns early (e.g. pipeline shutdown via abort signal). The actual error
    // is still available via the original promise stored in the map.
    const p = fetchPage(range).then((result) => ({ id, result }))
    p.catch(() => {})
    inflight.set(id, p)
    return true
  }

  /** Snapshot of all ranges not yet fully fetched (queued + in flight). */
  function snapshotRemaining(): Range[] {
    return [...inflightRanges.values(), ...queue]
  }

  // Fill up to concurrency
  while (launchNext()) {}

  try {
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
        const children = subdivideRanges(
          [range],
          new Map([[range, lastObserved]]),
          subdivisionFactor
        )
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
  } finally {
    // On early return (e.g. pipeline shutdown), swallow remaining in-flight
    // rejections — they are expected when the abort signal fires.
    inflight.clear()
  }
}
