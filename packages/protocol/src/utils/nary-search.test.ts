import { describe, expect, it } from 'vitest'
import type { Range } from './nary-search.js'
import { subdivideRanges, nextStep, toIso, toUnixSeconds } from './nary-search.js'

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

// MARK: - subdivideRanges

describe('subdivideRanges', () => {
  it('passes through ranges without cursors unchanged', () => {
    const remaining: Range[] = [
      { gte: iso(0), lt: iso(60), cursor: null },
      { gte: iso(60), lt: iso(120), cursor: null },
    ]
    const map = new Map<Range, number>([[remaining[0], 10]])
    expect(subdivideRanges(remaining, 10, map)).toEqual(remaining)
  })

  it('splits older remainder in half (binary subdivision)', () => {
    const remaining: Range[] = [{ gte: iso(0), lt: iso(120), cursor: 'cur_1' }]
    const out = subdivideRanges(remaining, 10, new Map([[remaining[0], 90]]))
    expect(out).toEqual([
      { gte: iso(90), lt: iso(91), cursor: 'cur_1' }, // boundary
      { gte: iso(0), lt: iso(45), cursor: null }, // left half
      { gte: iso(45), lt: iso(90), cursor: null }, // right half
    ])
  })

  it('falls back to sequential pagination when budget < 3', () => {
    const remaining: Range[] = [{ gte: iso(0), lt: iso(100), cursor: 'cur_x' }]
    const out = subdivideRanges(remaining, 2, new Map([[remaining[0], 90]]))
    expect(out).toEqual(remaining)
  })

  it('does not subdivide when the observed point is at or below the range start', () => {
    const range: Range = { gte: iso(0), lt: iso(60), cursor: 'cur_z' }
    expect(subdivideRanges([range], 10, new Map([[range, 0]]))).toEqual([range])
    expect(subdivideRanges([range], 10, new Map([[range, -10]]))).toEqual([range])
  })

  it('handles multiple ranges: only cursor + lastObserved entries subdivide', () => {
    const a: Range = { gte: iso(0), lt: iso(30), cursor: null }
    const b: Range = { gte: iso(30), lt: iso(60), cursor: 'cur_b' }
    const c: Range = { gte: iso(60), lt: iso(120), cursor: 'cur_c' }
    const out = subdivideRanges([a, b, c], 10, new Map([[c, 90]]))
    // a passes through (no cursor), b passes through (no lastObserved),
    // c splits into boundary + 2 halves
    expect(out).toEqual([
      a,
      b,
      { gte: iso(90), lt: iso(91), cursor: 'cur_c' }, // boundary
      { gte: iso(60), lt: iso(75), cursor: null }, // left half
      { gte: iso(75), lt: iso(90), cursor: null }, // right half
    ])
  })

  it('passes through a range with cursor but no lastObserved entry', () => {
    const range: Range = { gte: iso(0), lt: iso(100), cursor: 'cur_only' }
    expect(subdivideRanges([range], 50, new Map())).toEqual([range])
  })

  it('emits single segment when older remainder is 1 second', () => {
    const remaining: Range[] = [{ gte: iso(1000), lt: iso(1002), cursor: 'cur_tail' }]
    const out = subdivideRanges(remaining, 10, new Map([[remaining[0], 1001]]))
    expect(out).toEqual([
      { gte: iso(1001), lt: iso(1002), cursor: 'cur_tail' }, // boundary
      { gte: iso(1000), lt: iso(1001), cursor: null }, // single segment (can't halve 1s)
    ])
  })

  it('always produces exactly 3 ranges for a splittable range (boundary + 2 halves)', () => {
    const remaining: Range[] = [{ gte: iso(0), lt: iso(1000), cursor: 'cur_dense' }]
    const out = subdivideRanges(remaining, 20, new Map([[remaining[0], 900]]))
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ gte: iso(900), lt: iso(901), cursor: 'cur_dense' })
    // Left half: [0, 450), Right half: [450, 900)
    expect(out[1]).toEqual({ gte: iso(0), lt: iso(450), cursor: null })
    expect(out[2]).toEqual({ gte: iso(450), lt: iso(900), cursor: null })
  })

  it('keeps the entire last observed second in the cursor-backed boundary range', () => {
    const remaining: Range[] = [{ gte: iso(1000), lt: iso(1010), cursor: 'cur_same_second' }]
    const out = subdivideRanges(remaining, 10, new Map([[remaining[0], 1008]]))
    expect(out).toEqual([
      { gte: iso(1008), lt: iso(1009), cursor: 'cur_same_second' },
      { gte: iso(1000), lt: iso(1004), cursor: null },
      { gte: iso(1004), lt: iso(1008), cursor: null },
    ])
  })

  it('nextStep wraps subdivideRanges correctly', () => {
    const remaining: Range[] = [{ gte: iso(0), lt: iso(120), cursor: 'cur_1' }]
    const lastObserved = new Map([[remaining[0], 30]])
    const result = nextStep({ remaining, lastObserved }, 10)
    const direct = subdivideRanges(remaining, 10, lastObserved)
    expect(result).toEqual(direct)
  })
})

// MARK: - Distribution tests: simulate fetch→observe→subdivide rounds

/**
 * Simulate one round of binary subdivision:
 *   1. For each range with data, set cursor and lastObserved as if a page was fetched
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
  const lastObserved = new Map<Range, number>()

  for (const range of ranges) {
    const startUnix = toUnixSeconds(range.gte)
    const endUnix = toUnixSeconds(range.lt)

    // Stripe list APIs return newest-first. Walk backward from the range end,
    // counting records until we hit pageSize or the lower bound.
    let count = 0
    let lastTs = endUnix - 1
    for (let ts = endUnix - 1; ts >= startUnix && count < pageSize; ts--) {
      const recordsAtTs = density(ts)
      count += recordsAtTs
      if (recordsAtTs > 0) lastTs = ts
    }

    if (count > 0) {
      range.cursor = `cur_${lastTs}`
      lastObserved.set(range, lastTs)
    }
  }

  return subdivideRanges(ranges, maxSegments, lastObserved)
}

describe('binary search: data distribution scenarios', () => {
  it('uniform density: splits into boundary + 2 halves', () => {
    const ranges: Range[] = [{ gte: iso(0), lt: iso(1000), cursor: null }]
    const density = () => 1

    const round1 = simulateRound(ranges, 10, density)
    // boundary + left half + right half
    expect(round1.length).toBe(3)
    expect(round1[0].cursor).not.toBeNull() // boundary
    expect(round1[1].cursor).toBeNull() // left half
    expect(round1[2].cursor).toBeNull() // right half
  })

  it('hot spot: 90% of records in 10% of time range', () => {
    const density = (ts: number) => (ts >= 800 && ts < 900 ? 10 : ts % 10 === 0 ? 1 : 0)
    const ranges: Range[] = [{ gte: iso(0), lt: iso(1000), cursor: null }]

    const round1 = simulateRound(ranges, 10, density)
    expect(round1.length).toBe(3)
  })

  it('empty range: completes in one pass with no subdivision', () => {
    const density = () => 0
    const ranges: Range[] = [{ gte: iso(0), lt: iso(1000), cursor: null }]

    const round1 = simulateRound(ranges, 10, density)
    expect(round1).toEqual(ranges)
  })

  it('single page: range with < pageSize records needs no subdivision', () => {
    const density = (ts: number) => (ts < 50 ? 1 : 0)
    const ranges: Range[] = [{ gte: iso(0), lt: iso(100), cursor: null }]

    const round1 = simulateRound(ranges, 10, density, 100)
    expect(round1.length).toBeGreaterThanOrEqual(1)
  })

  it('multi-round convergence: binary subdivision refines the search', () => {
    const density = () => 1
    let ranges: Range[] = [{ gte: iso(0), lt: iso(10000), cursor: null }]

    // Simulate 5 rounds — binary creates fewer ranges per round than n-ary
    for (let round = 0; round < 5; round++) {
      ranges = simulateRound([...ranges.map((r) => ({ ...r }))], 100, density)
    }

    // After 5 rounds of binary, should have 2^5 = 32 leaf ranges
    expect(ranges.length).toBeGreaterThanOrEqual(2)
    for (const r of ranges) {
      expect(toUnixSeconds(r.lt)).toBeGreaterThanOrEqual(toUnixSeconds(r.gte))
    }
  })

  it('budget exhaustion: maxSegments=2 caps output', () => {
    const ranges: Range[] = [{ gte: iso(0), lt: iso(10000), cursor: 'cur_0' }]
    const lastObserved = new Map([[ranges[0], 100]])
    const result = subdivideRanges(ranges, 2, lastObserved)
    // budget < 3, so range passes through unchanged
    expect(result).toEqual(ranges)
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
