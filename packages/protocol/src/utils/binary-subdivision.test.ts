import { describe, expect, it } from 'vitest'
import type { Range, PageResult } from './binary-subdivision.js'
import {
  subdivideRanges,
  streamingSubdivide,
  toIso,
  toUnixSeconds,
  DEFAULT_SUBDIVISION_FACTOR,
} from './binary-subdivision.js'

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

const N = DEFAULT_SUBDIVISION_FACTOR

// MARK: - subdivideRanges

describe('subdivideRanges', () => {
  it('passes through ranges without cursors unchanged', () => {
    const remaining: Range[] = [
      { gte: iso(0), lt: iso(60), cursor: null },
      { gte: iso(60), lt: iso(120), cursor: null },
    ]
    const map = new Map<Range, number>([[remaining[0], 10]])
    expect(subdivideRanges(remaining, map, N)).toEqual(remaining)
  })

  it('splits older remainder into N equal segments', () => {
    const remaining: Range[] = [{ gte: iso(0), lt: iso(1000), cursor: 'cur_1' }]
    const out = subdivideRanges(remaining, new Map([[remaining[0], 900]]), N)
    // boundary + N segments of [0, 900)
    expect(out[0]).toEqual({ gte: iso(900), lt: iso(901), cursor: 'cur_1' })
    const segments = out.slice(1)
    expect(segments).toHaveLength(DEFAULT_SUBDIVISION_FACTOR)
    // All segments are contiguous and cover [0, 900)
    expect(toUnixSeconds(segments[0].gte)).toBe(0)
    expect(toUnixSeconds(segments[segments.length - 1].lt)).toBe(900)
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].gte).toBe(segments[i - 1].lt)
    }
    // All cursors are null
    for (const s of segments) expect(s.cursor).toBeNull()
  })

  it('does not subdivide when the observed point is at or below the range start', () => {
    const range: Range = { gte: iso(0), lt: iso(60), cursor: 'cur_z' }
    expect(subdivideRanges([range], new Map([[range, 0]]), N)).toEqual([range])
    expect(subdivideRanges([range], new Map([[range, -10]]), N)).toEqual([range])
  })

  it('handles multiple ranges: only cursor + lastObserved entries subdivide', () => {
    const a: Range = { gte: iso(0), lt: iso(30), cursor: null }
    const b: Range = { gte: iso(30), lt: iso(60), cursor: 'cur_b' }
    const c: Range = { gte: iso(60), lt: iso(120), cursor: 'cur_c' }
    const out = subdivideRanges([a, b, c], new Map([[c, 90]]), N)
    // a passes through, b passes through (no lastObserved), c subdivides
    expect(out[0]).toEqual(a)
    expect(out[1]).toEqual(b)
    expect(out[2]).toEqual({ gte: iso(90), lt: iso(91), cursor: 'cur_c' })
    // Remaining segments cover [60, 90) with N segments (capped to span)
    const segments = out.slice(3)
    expect(segments.length).toBeGreaterThanOrEqual(1)
    expect(toUnixSeconds(segments[0].gte)).toBe(60)
    expect(toUnixSeconds(segments[segments.length - 1].lt)).toBe(90)
  })

  it('passes through a range with cursor but no lastObserved entry', () => {
    const range: Range = { gte: iso(0), lt: iso(100), cursor: 'cur_only' }
    expect(subdivideRanges([range], new Map(), N)).toEqual([range])
  })

  it('emits single segment when older remainder is 1 second', () => {
    const remaining: Range[] = [{ gte: iso(1000), lt: iso(1002), cursor: 'cur_tail' }]
    const out = subdivideRanges(remaining, new Map([[remaining[0], 1001]]), N)
    expect(out).toEqual([
      { gte: iso(1001), lt: iso(1002), cursor: 'cur_tail' },
      { gte: iso(1000), lt: iso(1001), cursor: null },
    ])
  })

  it('produces boundary + N segments for a splittable range', () => {
    const remaining: Range[] = [{ gte: iso(0), lt: iso(1000), cursor: 'cur_dense' }]
    const out = subdivideRanges(remaining, new Map([[remaining[0], 900]]), N)
    expect(out).toHaveLength(1 + DEFAULT_SUBDIVISION_FACTOR) // boundary + N segments
    expect(out[0]).toEqual({ gte: iso(900), lt: iso(901), cursor: 'cur_dense' })
    // Segments cover [0, 900) contiguously
    for (let i = 2; i < out.length; i++) {
      expect(out[i].gte).toBe(out[i - 1].lt)
    }
  })

  it('keeps the entire last observed second in the cursor-backed boundary range', () => {
    const remaining: Range[] = [{ gte: iso(1000), lt: iso(1010), cursor: 'cur_same_second' }]
    const out = subdivideRanges(remaining, new Map([[remaining[0], 1008]]), N)
    expect(out[0]).toEqual({ gte: iso(1008), lt: iso(1009), cursor: 'cur_same_second' })
    // Remaining segments cover [1000, 1008) — 8 seconds, capped at min(N, 8)
    const segments = out.slice(1)
    expect(segments.length).toBe(Math.min(DEFAULT_SUBDIVISION_FACTOR, 8))
    expect(toUnixSeconds(segments[0].gte)).toBe(1000)
    expect(toUnixSeconds(segments[segments.length - 1].lt)).toBe(1008)
  })
})

// MARK: - Distribution simulation

function simulateRound(ranges: Range[], density: (ts: number) => number, pageSize = 100): Range[] {
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

  return subdivideRanges(ranges, lastObserved, N)
}

describe('binary subdivision: data distribution scenarios', () => {
  it('uniform density: splits into boundary + N segments', () => {
    const ranges: Range[] = [{ gte: iso(0), lt: iso(1000), cursor: null }]
    const round1 = simulateRound(ranges, () => 1)
    expect(round1.length).toBe(1 + DEFAULT_SUBDIVISION_FACTOR) // boundary + N segments
    expect(round1[0].cursor).not.toBeNull() // boundary keeps cursor
    for (let i = 1; i < round1.length; i++) {
      expect(round1[i].cursor).toBeNull() // segments start fresh
    }
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

// MARK: - streamingSubdivide

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of gen) items.push(item)
  return items
}

describe('streamingSubdivide', () => {
  it('single empty range: one fetch, zero data', async () => {
    const events = await collect(
      streamingSubdivide<string>({
        initial: [{ gte: iso(0), lt: iso(100), cursor: null }],
        fetchPage: async (range) => ({
          range,
          data: [],
          hasMore: false,
          lastObserved: null,
        }),
        concurrency: 4,
        subdivisionFactor: N,
      })
    )
    expect(events).toHaveLength(1)
    expect(events[0].data).toEqual([])
    expect(events[0].exhausted).toBe(true)
  })

  it('single range, single page of data', async () => {
    const events = await collect(
      streamingSubdivide<string>({
        initial: [{ gte: iso(0), lt: iso(100), cursor: null }],
        fetchPage: async (range) => {
          range.cursor = 'cur_1'
          return { range, data: ['a', 'b'], hasMore: false, lastObserved: 50 }
        },
        concurrency: 4,
        subdivisionFactor: N,
      })
    )
    expect(events).toHaveLength(1)
    expect(events[0].data).toEqual(['a', 'b'])
    expect(events[0].exhausted).toBe(true)
  })

  it('subdivides a range with more data and processes children', async () => {
    let fetchCount = 0
    const events = await collect(
      streamingSubdivide<string>({
        initial: [{ gte: iso(0), lt: iso(1000), cursor: null }],
        fetchPage: async (range) => {
          fetchCount++
          const start = toUnixSeconds(range.gte)
          const end = toUnixSeconds(range.lt)

          // Data concentrated at 800-1000; newest-first (Stripe order)
          if (end > 800) {
            range.cursor = `cur_${fetchCount}`
            // Oldest record on this page is at 800
            return { range, data: ['record'], hasMore: end - 800 > 100, lastObserved: 800 }
          }
          // Everything below 800 is empty
          return { range, data: [], hasMore: false, lastObserved: null }
        },
        concurrency: 4,
        subdivisionFactor: N,
      })
    )

    // Initial [0, 1000): has data at 800+, hasMore=true, lastObserved=800
    // → subdivides into: boundary [800, 801) + [0, 400) + [400, 800)
    // [0, 400) and [400, 800) are empty. Boundary may or may not need more pages.
    expect(fetchCount).toBeGreaterThanOrEqual(3) // initial + at least 2 empty children
    expect(events.length).toBeGreaterThanOrEqual(3)

    const dataEvents = events.filter((e) => e.data.length > 0)
    expect(dataEvents.length).toBeGreaterThan(0)
  })

  it('respects concurrency limit', async () => {
    let maxConcurrent = 0
    let currentConcurrent = 0

    const events = await collect(
      streamingSubdivide<string>({
        initial: [
          { gte: iso(0), lt: iso(100), cursor: null },
          { gte: iso(100), lt: iso(200), cursor: null },
          { gte: iso(200), lt: iso(300), cursor: null },
          { gte: iso(300), lt: iso(400), cursor: null },
        ],
        fetchPage: async (range) => {
          currentConcurrent++
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
          await new Promise((r) => setTimeout(r, 10))
          currentConcurrent--
          return { range, data: ['x'], hasMore: false, lastObserved: null }
        },
        concurrency: 2,
        subdivisionFactor: N,
      })
    )

    expect(events).toHaveLength(4)
    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  it('drains boundary ranges sequentially via cursor', async () => {
    let pagesFetched = 0
    const events = await collect(
      streamingSubdivide<number>({
        initial: [{ gte: iso(100), lt: iso(101), cursor: 'start' }],
        fetchPage: async (range) => {
          pagesFetched++
          if (pagesFetched < 3) {
            range.cursor = `cur_${pagesFetched}`
            return { range, data: [pagesFetched], hasMore: true, lastObserved: 100 }
          }
          return { range, data: [pagesFetched], hasMore: false, lastObserved: null }
        },
        concurrency: 4,
        subdivisionFactor: N,
      })
    )

    expect(pagesFetched).toBe(3)
    const allData = events.flatMap((e) => e.data)
    expect(allData).toEqual([1, 2, 3])
  })

  it('handles skewed data: empty prefix wastes minimal calls', async () => {
    // Simulate: [0, 10000) but data only in [9000, 10000)
    let fetchCount = 0
    await collect(
      streamingSubdivide<string>({
        initial: [{ gte: iso(0), lt: iso(10000), cursor: null }],
        fetchPage: async (range) => {
          fetchCount++
          const start = toUnixSeconds(range.gte)
          const end = toUnixSeconds(range.lt)

          if (end <= 9000) {
            // Empty range
            return { range, data: [], hasMore: false, lastObserved: null }
          }

          // Has data — return one page, set cursor
          const dataStart = Math.max(start, 9000)
          range.cursor = `cur_${fetchCount}`
          return {
            range,
            data: ['record'],
            hasMore: end - dataStart > 100, // more if range is large
            lastObserved: dataStart,
          }
        },
        concurrency: 8,
        subdivisionFactor: N,
      })
    )

    // Binary subdivision of [0, 9000) should produce O(log2(9000)) ≈ 13 empty probes
    // Plus the data-bearing ranges. Total should be well under 50.
    expect(fetchCount).toBeLessThan(50)
  })

  it('does not get stuck on range with hasMore but no lastObserved', async () => {
    let calls = 0
    const events = await collect(
      streamingSubdivide<string>({
        initial: [{ gte: iso(0), lt: iso(100), cursor: null }],
        fetchPage: async (range) => {
          calls++
          if (calls === 1) {
            range.cursor = 'cur_1'
            return { range, data: ['a'], hasMore: true, lastObserved: null }
          }
          // Second call: done
          return { range, data: ['b'], hasMore: false, lastObserved: null }
        },
        concurrency: 4,
        subdivisionFactor: N,
      })
    )

    expect(calls).toBe(2)
    const allData = events.flatMap((e) => e.data)
    expect(allData).toEqual(['a', 'b'])
  })
})

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
