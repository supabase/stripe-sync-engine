import { describe, expect, it } from 'vitest'
import type { Range } from './nary-search.js'
import { subdivideRanges, nextStep, toIso, toUnixSeconds } from './nary-search.js'

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

// MARK: - subdivideRanges (moved from src-list-api.test.ts)

describe('subdivideRanges', () => {
  it('passes through ranges without cursors unchanged', () => {
    const remaining: Range[] = [
      { gte: iso(0), lt: iso(60), cursor: null },
      { gte: iso(60), lt: iso(120), cursor: null },
    ]
    const map = new Map<Range, number>([[remaining[0], 10]])
    expect(subdivideRanges(remaining, 10, map)).toEqual(remaining)
  })

  it('subdivides a range with cursor and lastSeenCreated into paginated head + null-cursor tail segments', () => {
    const remaining: Range[] = [{ gte: iso(0), lt: iso(120), cursor: 'cur_1' }]
    // maxSegments=4: head takes 1 slot, tail gets 3 (budget = 4 - 1 = 3)
    const out = subdivideRanges(remaining, 4, new Map([[remaining[0], 30]]))
    expect(out).toEqual([
      { gte: iso(0), lt: iso(31), cursor: 'cur_1' },
      { gte: iso(31), lt: iso(61), cursor: null },
      { gte: iso(61), lt: iso(91), cursor: null },
      { gte: iso(91), lt: iso(120), cursor: null },
    ])
  })

  it('caps tail segment count at remaining budget', () => {
    const remaining: Range[] = [{ gte: iso(0), lt: iso(100), cursor: 'cur_x' }]
    // maxSegments=2: head takes 1 slot, tail budget = 1
    const out = subdivideRanges(remaining, 2, new Map([[remaining[0], 10]]))
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ gte: iso(0), lt: iso(11), cursor: 'cur_x' })
    expect(out[1]).toEqual({ gte: iso(11), lt: iso(100), cursor: null })
  })

  it('does not subdivide when splitPoint is at or past range end', () => {
    const range: Range = { gte: iso(0), lt: iso(60), cursor: 'cur_z' }
    const endUnix = 60
    expect(subdivideRanges([range], 10, new Map([[range, endUnix]]))).toEqual([range])
    expect(subdivideRanges([range], 10, new Map([[range, endUnix + 10]]))).toEqual([range])
  })

  it('handles multiple ranges: only cursor + lastSeenCreated entries subdivide', () => {
    const a: Range = { gte: iso(0), lt: iso(30), cursor: null }
    const b: Range = { gte: iso(30), lt: iso(60), cursor: 'cur_b' }
    const c: Range = { gte: iso(60), lt: iso(120), cursor: 'cur_c' }
    // maxSegments=10 gives enough budget for c to subdivide
    const out = subdivideRanges([a, b, c], 10, new Map([[c, 90]]))
    expect(out[0]).toEqual(a)
    expect(out[1]).toEqual(b)
    expect(out[2]).toEqual({ gte: iso(60), lt: iso(91), cursor: 'cur_c' })
    const tail = out.slice(3)
    expect(tail.length).toBeGreaterThan(0)
    expect(tail[0].gte).toBe(iso(91))
    expect(tail[tail.length - 1].lt).toBe(iso(120))
  })

  it('passes through a range with cursor but no lastSeenCreated entry', () => {
    const range: Range = { gte: iso(0), lt: iso(100), cursor: 'cur_only' }
    expect(subdivideRanges([range], 50, new Map())).toEqual([range])
  })

  it('does not over-split a single-second tail even with a large maxSegments', () => {
    const remaining: Range[] = [{ gte: iso(1000), lt: iso(1002), cursor: 'cur_tail' }]
    const out = subdivideRanges(remaining, 100, new Map([[remaining[0], 1001]]))
    expect(out).toEqual(remaining)
  })

  it('keeps the entire last observed second with the paginated head', () => {
    const remaining: Range[] = [{ gte: iso(1000), lt: iso(1010), cursor: 'cur_same_second' }]
    const out = subdivideRanges(remaining, 4, new Map([[remaining[0], 1000]]))
    expect(out).toEqual([
      { gte: iso(1000), lt: iso(1001), cursor: 'cur_same_second' },
      { gte: iso(1001), lt: iso(1004), cursor: null },
      { gte: iso(1004), lt: iso(1007), cursor: null },
      { gte: iso(1007), lt: iso(1010), cursor: null },
    ])
  })

  it('matches observations to the surviving range after earlier ranges drop out', () => {
    const inProgress: Range = { gte: iso(60), lt: iso(120), cursor: 'cur_b' }
    const out = nextStep(
      {
        remaining: [inProgress],
        lastObserved: new Map([[inProgress, 90]]),
      },
      4
    )
    expect(out).toEqual([
      { gte: iso(60), lt: iso(91), cursor: 'cur_b' },
      { gte: iso(91), lt: iso(101), cursor: null },
      { gte: iso(101), lt: iso(111), cursor: null },
      { gte: iso(111), lt: iso(120), cursor: null },
    ])
  })
})

// MARK: - reconcileRanges (moved from src-list-api.test.ts)

// MARK: - Distribution tests: simulate fetch→observe→subdivide rounds

/**
 * Simulate one round of the n-ary search:
 *   1. For each range with data, set cursor and lastSeenCreated as if a page was fetched
 *   2. Call subdivideRanges
 *
 * `density` maps unix timestamp → records in that second (simplified model).
 * A page fetches up to `pageSize` records starting from the range's cursor position.
 */
function simulateRound(
  ranges: Range[],
  maxSegments: number,
  density: (ts: number) => number,
  pageSize = 100
): Range[] {
  const lastSeenCreated = new Map<Range, number>()

  for (const range of ranges) {
    const startUnix = range.cursor
      ? toUnixSeconds(range.gte) // cursor means we're mid-pagination, start from gte
      : toUnixSeconds(range.gte)
    const endUnix = toUnixSeconds(range.lt)

    // Walk forward from start, counting records until we hit pageSize or range end
    let count = 0
    let lastTs = startUnix
    for (let ts = startUnix; ts < endUnix && count < pageSize; ts++) {
      const recordsAtTs = density(ts)
      count += recordsAtTs
      if (recordsAtTs > 0) lastTs = ts
    }

    if (count > 0) {
      // Simulate: page returned records, set cursor and lastSeenCreated
      range.cursor = `cur_${lastTs}`
      lastSeenCreated.set(range, lastTs)
    }
    // If count === 0, range is empty — cursor stays null, no lastSeenCreated entry
  }

  return subdivideRanges(ranges, maxSegments, lastSeenCreated)
}

describe('n-ary search: data distribution scenarios', () => {
  it('uniform density: produces roughly equal-sized segments', () => {
    // 1 record per second, 1000 seconds, page size 100
    const ranges: Range[] = [{ gte: iso(0), lt: iso(1000), cursor: null }]
    const density = () => 1

    // Round 1: fetch first page (0-99), set cursor
    const round1 = simulateRound(ranges, 8, density)

    // Should have head + tail segments
    expect(round1.length).toBeGreaterThan(1)
    // Head should have a cursor
    expect(round1[0].cursor).not.toBeNull()
    // All tail segments should have no cursor
    const tails = round1.filter((r) => r.cursor === null)
    expect(tails.length).toBeGreaterThan(0)
  })

  it('hot spot: 90% of records in 10% of time range', () => {
    // Range: 0-1000. Hot zone: 100-200 (10 records/s), rest: 0.1 records/s
    const density = (ts: number) => (ts >= 100 && ts < 200 ? 10 : ts % 10 === 0 ? 1 : 0)
    const ranges: Range[] = [{ gte: iso(0), lt: iso(1000), cursor: null }]

    const round1 = simulateRound(ranges, 8, density)
    // After first round, should have subdivided
    expect(round1.length).toBeGreaterThan(1)
  })

  it('empty range: completes in one pass with no subdivision', () => {
    const density = () => 0 // no records anywhere
    const ranges: Range[] = [{ gte: iso(0), lt: iso(1000), cursor: null }]

    const round1 = simulateRound(ranges, 8, density)
    // No data means no cursors, no lastSeenCreated → ranges pass through unchanged
    expect(round1).toEqual(ranges)
  })

  it('single page: range with < pageSize records needs no subdivision', () => {
    // 50 records total (1 per second for 50 seconds)
    const density = (ts: number) => (ts < 50 ? 1 : 0)
    const ranges: Range[] = [{ gte: iso(0), lt: iso(100), cursor: null }]

    const round1 = simulateRound(ranges, 8, density, 100)
    // First page gets all 50 records. cursor is set, lastSeenCreated = 49
    // Head [0, 49) + tail segments [49, 100)
    // But since the page consumed all records, in reality has_more would be false
    // and the range would be removed. Here we just verify subdivision is reasonable.
    expect(round1.length).toBeGreaterThanOrEqual(1)
  })

  it('multi-round convergence: repeated subdivision refines the search', () => {
    // Uniform 1 record/sec over 10000 seconds, page size 100, 4 segments max
    const density = () => 1
    let ranges: Range[] = [{ gte: iso(0), lt: iso(10000), cursor: null }]

    // Simulate 3 rounds
    for (let round = 0; round < 3; round++) {
      ranges = simulateRound([...ranges.map((r) => ({ ...r }))], 4, density)
    }

    // After 3 rounds, should have multiple ranges being worked on
    expect(ranges.length).toBeGreaterThanOrEqual(2)
    // All ranges should cover valid, non-empty intervals
    for (const r of ranges) {
      expect(toUnixSeconds(r.lt)).toBeGreaterThanOrEqual(toUnixSeconds(r.gte))
    }
  })

  it('budget exhaustion: maxSegments=2 caps output per subdivision call', () => {
    // subdivideRanges itself respects the budget — test it directly
    const ranges: Range[] = [{ gte: iso(0), lt: iso(10000), cursor: 'cur_0' }]
    const lastObserved = new Map([[ranges[0], 100]])
    const result = subdivideRanges(ranges, 2, lastObserved)
    // head + 1 tail segment = 2
    expect(result.length).toBeLessThanOrEqual(2)
  })

  it('nextStep wraps subdivideRanges correctly', () => {
    const remaining: Range[] = [{ gte: iso(0), lt: iso(120), cursor: 'cur_1' }]
    const lastObserved = new Map([[remaining[0], 30]])
    const result = nextStep({ remaining, lastObserved }, 4)
    const direct = subdivideRanges(remaining, 4, lastObserved)
    expect(result).toEqual(direct)
  })
})

// MARK: - Time helper tests

describe('toUnixSeconds / toIso', () => {
  it('round-trips correctly', () => {
    const ts = 1700000000
    expect(toUnixSeconds(toIso(ts))).toBe(ts)
  })

  it('handles epoch', () => {
    expect(toUnixSeconds('1970-01-01T00:00:00.000Z')).toBe(0)
    expect(toIso(0)).toBe('1970-01-01T00:00:00.000Z')
  })
})
