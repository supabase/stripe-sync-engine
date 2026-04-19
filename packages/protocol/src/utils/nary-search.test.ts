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
    expect(subdivideRanges(remaining, map)).toEqual(remaining)
  })

  it('splits older remainder in half (binary subdivision)', () => {
    const remaining: Range[] = [{ gte: iso(0), lt: iso(120), cursor: 'cur_1' }]
    const out = subdivideRanges(remaining, new Map([[remaining[0], 90]]))
    expect(out).toEqual([
      { gte: iso(90), lt: iso(91), cursor: 'cur_1' }, // boundary
      { gte: iso(0), lt: iso(45), cursor: null }, // left half
      { gte: iso(45), lt: iso(90), cursor: null }, // right half
    ])
  })

  it('does not subdivide when the observed point is at or below the range start', () => {
    const range: Range = { gte: iso(0), lt: iso(60), cursor: 'cur_z' }
    expect(subdivideRanges([range], new Map([[range, 0]]))).toEqual([range])
    expect(subdivideRanges([range], new Map([[range, -10]]))).toEqual([range])
  })

  it('handles multiple ranges: only cursor + lastObserved entries subdivide', () => {
    const a: Range = { gte: iso(0), lt: iso(30), cursor: null }
    const b: Range = { gte: iso(30), lt: iso(60), cursor: 'cur_b' }
    const c: Range = { gte: iso(60), lt: iso(120), cursor: 'cur_c' }
    const out = subdivideRanges([a, b, c], new Map([[c, 90]]))
    expect(out).toEqual([
      a,
      b,
      { gte: iso(90), lt: iso(91), cursor: 'cur_c' },
      { gte: iso(60), lt: iso(75), cursor: null },
      { gte: iso(75), lt: iso(90), cursor: null },
    ])
  })

  it('passes through a range with cursor but no lastObserved entry', () => {
    const range: Range = { gte: iso(0), lt: iso(100), cursor: 'cur_only' }
    expect(subdivideRanges([range], new Map())).toEqual([range])
  })

  it('emits single segment when older remainder is 1 second', () => {
    const remaining: Range[] = [{ gte: iso(1000), lt: iso(1002), cursor: 'cur_tail' }]
    const out = subdivideRanges(remaining, new Map([[remaining[0], 1001]]))
    expect(out).toEqual([
      { gte: iso(1001), lt: iso(1002), cursor: 'cur_tail' },
      { gte: iso(1000), lt: iso(1001), cursor: null },
    ])
  })

  it('always produces exactly 3 ranges for a splittable range (boundary + 2 halves)', () => {
    const remaining: Range[] = [{ gte: iso(0), lt: iso(1000), cursor: 'cur_dense' }]
    const out = subdivideRanges(remaining, new Map([[remaining[0], 900]]))
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ gte: iso(900), lt: iso(901), cursor: 'cur_dense' })
    expect(out[1]).toEqual({ gte: iso(0), lt: iso(450), cursor: null })
    expect(out[2]).toEqual({ gte: iso(450), lt: iso(900), cursor: null })
  })

  it('keeps the entire last observed second in the cursor-backed boundary range', () => {
    const remaining: Range[] = [{ gte: iso(1000), lt: iso(1010), cursor: 'cur_same_second' }]
    const out = subdivideRanges(remaining, new Map([[remaining[0], 1008]]))
    expect(out).toEqual([
      { gte: iso(1008), lt: iso(1009), cursor: 'cur_same_second' },
      { gte: iso(1000), lt: iso(1004), cursor: null },
      { gte: iso(1004), lt: iso(1008), cursor: null },
    ])
  })

  it('nextStep wraps subdivideRanges correctly', () => {
    const remaining: Range[] = [{ gte: iso(0), lt: iso(120), cursor: 'cur_1' }]
    const lastObserved = new Map([[remaining[0], 30]])
    const result = nextStep({ remaining, lastObserved })
    const direct = subdivideRanges(remaining, lastObserved)
    expect(result).toEqual(direct)
  })
})

// MARK: - Distribution simulation

function simulateRound(
  ranges: Range[],
  density: (ts: number) => number,
  pageSize = 100
): Range[] {
  const lastObserved = new Map<Range, number>()

  for (const range of ranges) {
    const startUnix = toUnixSeconds(range.gte)
    const endUnix = toUnixSeconds(range.lt)

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

  return subdivideRanges(ranges, lastObserved)
}

describe('binary subdivision: data distribution scenarios', () => {
  it('uniform density: splits into boundary + 2 halves', () => {
    const ranges: Range[] = [{ gte: iso(0), lt: iso(1000), cursor: null }]
    const round1 = simulateRound(ranges, () => 1)
    expect(round1.length).toBe(3)
    expect(round1[0].cursor).not.toBeNull()
    expect(round1[1].cursor).toBeNull()
    expect(round1[2].cursor).toBeNull()
  })

  it('empty range: completes in one pass with no subdivision', () => {
    const ranges: Range[] = [{ gte: iso(0), lt: iso(1000), cursor: null }]
    const round1 = simulateRound(ranges, () => 0)
    expect(round1).toEqual(ranges)
  })

  it('multi-round convergence: binary subdivision refines the search', () => {
    let ranges: Range[] = [{ gte: iso(0), lt: iso(10000), cursor: null }]

    for (let round = 0; round < 5; round++) {
      ranges = simulateRound([...ranges.map((r) => ({ ...r }))], () => 1)
    }

    expect(ranges.length).toBeGreaterThanOrEqual(2)
    for (const r of ranges) {
      expect(toUnixSeconds(r.lt)).toBeGreaterThanOrEqual(toUnixSeconds(r.gte))
    }
  })
})

// MARK: - Time helpers

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
