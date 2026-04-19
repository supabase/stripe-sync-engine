/**
 * N-ary search scheduler — a pure, self-replicating parallel time-range search.
 *
 * Algorithm:
 *   1. Start with one or more time ranges to search.
 *   2. Fetch one page from each range in parallel (up to a concurrency budget).
 *   3. Observe: record the last sort-key value seen in each page.
 *   4. Subdivide: split ranges that have a cursor into a paginated head (keeps cursor)
 *      and an unpaginated tail (split into N parts based on observed density).
 *   5. Repeat until no ranges remain.
 *
 * All functions here are pure — data in, data out, no I/O, no side effects.
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

/** Scheduler state between fetch rounds. */
export type SearchState = {
  remaining: Range[]
  /** Maps the fetched range → last observed sort-key value (unix seconds) in that range's page. */
  lastObserved: Map<Range, number>
}

/**
 * Large fan-out creates lots of tiny ranges for dense streams, which burns
 * requests on undersized pages. Keep each subdivision round modest and let
 * later rounds refine only the segments that stay dense.
 */
const MAX_TAIL_SEGMENTS_PER_RANGE = 16

// MARK: - Time helpers

export function toUnixSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000)
}

export function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

// MARK: - Subdivision

/**
 * Pure scheduler step: given the current backfill state, subdivide ranges that
 * made progress (have a cursor + lastObserved) into parallel segments.
 *
 * Call this AFTER fetching pages (which populate lastObserved and cursors).
 */
export function nextStep(state: SearchState, maxSegments: number): Range[] {
  return subdivideRanges(state.remaining, maxSegments, state.lastObserved)
}

/**
 * Subdivide ranges that have a cursor (were in progress but didn't complete).
 *
 * Stripe list APIs return newest records first. After one page, the newer side
 * of the range is already fetched; the unfetched remainder is the older side,
 * plus the boundary second that may still have more rows after the current
 * cursor.
 *
 * If we decide to split, keep the boundary second as a cursor-backed range and
 * split only the older remainder into fresh null-cursor segments.
 */
export function subdivideRanges(
  remaining: Range[],
  maxSegments: number,
  lastObserved: Map<Range, number>
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

    if (olderEndUnix <= rangeStartUnix) {
      result.push(range)
      continue
    }

    const budget = maxSegments - result.length - 1
    const olderSpan = olderEndUnix - rangeStartUnix
    const observedSpan = Math.max(1, rangeEndUnix - splitPoint)
    const estimatedOlderPages = Math.max(1, Math.ceil(olderSpan / observedSpan))
    const n = Math.min(
      MAX_TAIL_SEGMENTS_PER_RANGE,
      budget,
      Math.max(1, olderSpan),
      estimatedOlderPages
    )

    if (n <= 1) {
      // Likely one more page: keep sequential pagination and preserve the
      // cursor rather than creating an extra boundary checkpoint.
      result.push(range)
      continue
    }

    const boundaryGteUnix = Math.max(rangeStartUnix, splitPoint)
    const boundaryLtUnix = Math.min(rangeEndUnix, splitPoint + 1)
    result.push({ gte: toIso(boundaryGteUnix), lt: toIso(boundaryLtUnix), cursor: range.cursor })

    const segmentSize = Math.max(1, Math.ceil(olderSpan / n))

    for (let j = 0; j < n; j++) {
      const segGte = rangeStartUnix + j * segmentSize
      const segLt =
        j === n - 1
          ? olderEndUnix
          : Math.min(olderEndUnix, rangeStartUnix + (j + 1) * segmentSize)
      if (segGte >= olderEndUnix) break
      result.push({ gte: toIso(segGte), lt: toIso(segLt), cursor: null })
    }
  }

  return result
}
