/**
 * Binary subdivision scheduler — a pure, self-replicating parallel time-range search.
 *
 * Algorithm:
 *   1. Start with one or more time ranges to search.
 *   2. Fetch one page from each range in parallel (up to a concurrency budget).
 *   3. Observe: record the last sort-key value seen in each page.
 *   4. Subdivide: split ranges that have a cursor into a boundary (keeps cursor)
 *      and two halves of the unfetched remainder.
 *   5. Repeat until no ranges remain.
 *
 * See docs/architecture/binary-subdivision.md for complexity analysis.
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
 * Binary subdivision: split the older remainder in half. Simple, bounded waste
 * (at most 1 empty segment per split), converges in O(log₂ M) rounds.
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

    // Nothing older to split — keep paginating sequentially.
    if (olderEndUnix <= rangeStartUnix) {
      result.push(range)
      continue
    }

    // Need at least 3 slots: boundary + 2 halves.
    const budget = maxSegments - result.length
    if (budget < 3) {
      result.push(range)
      continue
    }

    // Boundary range: keeps the cursor to drain remaining records at this second.
    const boundaryGteUnix = Math.max(rangeStartUnix, splitPoint)
    const boundaryLtUnix = Math.min(rangeEndUnix, splitPoint + 1)
    result.push({ gte: toIso(boundaryGteUnix), lt: toIso(boundaryLtUnix), cursor: range.cursor })

    // Split the older remainder [rangeStart, splitPoint) in half.
    const midpoint = rangeStartUnix + Math.floor((olderEndUnix - rangeStartUnix) / 2)

    if (midpoint <= rangeStartUnix || midpoint >= olderEndUnix) {
      // Remainder is 1 second — can't split further, single segment.
      result.push({ gte: toIso(rangeStartUnix), lt: toIso(olderEndUnix), cursor: null })
    } else {
      result.push({ gte: toIso(rangeStartUnix), lt: toIso(midpoint), cursor: null })
      result.push({ gte: toIso(midpoint), lt: toIso(olderEndUnix), cursor: null })
    }
  }

  return result
}
