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
  /** Maps batch index → last observed sort-key value (unix seconds) in that range's page. */
  lastObserved: Map<number, number>
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
 * The paginated portion keeps its cursor; the unpaginated tail splits into N parts.
 *
 * `lastObserved` maps range index to the `created` timestamp of the last
 * record seen in that range (used to determine the split point).
 *
 * Segment sizing: the head range covered (splitPoint - rangeGte) seconds in one
 * page, so we use that as the minimum segment size to avoid creating segments
 * smaller than one page's worth of data.
 */
export function subdivideRanges(
  remaining: Range[],
  maxSegments: number,
  lastObserved: Map<number, number>
): Range[] {
  const result: Range[] = []

  for (let i = 0; i < remaining.length; i++) {
    const range = remaining[i]
    if (range.cursor === null || !lastObserved.has(i)) {
      result.push(range)
      continue
    }

    const splitPoint = lastObserved.get(i)!
    const splitPointIso = toIso(splitPoint)
    const rangeEndUnix = toUnixSeconds(range.lt)

    if (splitPoint >= rangeEndUnix) {
      result.push(range)
      continue
    }

    // Keep the paginated portion with its cursor
    result.push({ gte: range.gte, lt: splitPointIso, cursor: range.cursor })

    // Only subdivide if we're below the segment budget
    if (result.length >= maxSegments) {
      // Over budget — keep the tail as one range
      result.push({ gte: splitPointIso, lt: range.lt, cursor: null })
      continue
    }

    // Split the unpaginated tail into as many segments as the budget allows.
    // Sparse segments complete in one page and free up budget for the next round.
    // Dense segments get subdivided further on subsequent rounds.
    const budget = maxSegments - result.length
    const tailSpan = rangeEndUnix - splitPoint
    const n = Math.min(budget, Math.max(1, tailSpan))
    const segmentSize = Math.max(1, Math.ceil(tailSpan / n))

    for (let j = 0; j < n; j++) {
      const segGte = splitPoint + j * segmentSize
      const segLt = j === n - 1 ? rangeEndUnix : splitPoint + (j + 1) * segmentSize
      if (segGte >= rangeEndUnix) break
      result.push({ gte: toIso(segGte), lt: toIso(segLt), cursor: null })
    }
  }

  return result
}
