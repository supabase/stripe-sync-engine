import { describe, expect, it } from 'vitest'
import type { SegmentState, BackfillState } from './index.js'
import {
  compactState,
  expandState,
  probeAndBuildSegments,
  segmentCountFromDensity,
} from './src-list-api.js'

const seg = (
  index: number,
  gte: number,
  lt: number,
  status: 'pending' | 'complete',
  page_cursor: string | null = null
): SegmentState => ({ index, gte, lt, page_cursor, status })

const range = { gte: 0, lt: 1000 }

describe('compactState', () => {
  it('returns empty completed/inFlight for all-pending segments', () => {
    const segments = [seg(0, 0, 500, 'pending'), seg(1, 500, 1000, 'pending')]
    const state = compactState(segments, range, 2)
    expect(state.completed).toEqual([])
    expect(state.in_flight).toEqual([])
    expect(state.range).toEqual(range)
    expect(state.num_segments).toBe(2)
  })

  it('merges adjacent completed segments', () => {
    const segments = [
      seg(0, 0, 250, 'complete'),
      seg(1, 250, 500, 'complete'),
      seg(2, 500, 750, 'pending'),
      seg(3, 750, 1000, 'pending'),
    ]
    const state = compactState(segments, range, 4)
    expect(state.completed).toEqual([{ gte: 0, lt: 500 }])
    expect(state.in_flight).toEqual([])
  })

  it('captures in-flight segments with cursors', () => {
    const segments = [
      seg(0, 0, 500, 'complete'),
      seg(1, 500, 750, 'pending', 'cur_abc'),
      seg(2, 750, 1000, 'pending'),
    ]
    const state = compactState(segments, range, 3)
    expect(state.completed).toEqual([{ gte: 0, lt: 500 }])
    expect(state.in_flight).toEqual([{ gte: 500, lt: 750, page_cursor: 'cur_abc' }])
  })

  it('produces small state for 200-segment backfill', () => {
    // Simulate: first 50 complete, 1 in-flight, rest pending
    const segments: SegmentState[] = []
    for (let i = 0; i < 200; i++) {
      const gte = i * 5
      const lt = (i + 1) * 5
      if (i < 50) segments.push(seg(i, gte, lt, 'complete'))
      else if (i === 50) segments.push(seg(i, gte, lt, 'pending', 'cur_xyz'))
      else segments.push(seg(i, gte, lt, 'pending'))
    }
    const state = compactState(segments, { gte: 0, lt: 1000 }, 200)
    expect(state.completed).toEqual([{ gte: 0, lt: 250 }])
    expect(state.in_flight).toEqual([{ gte: 250, lt: 255, page_cursor: 'cur_xyz' }])
    // State JSON should be tiny
    expect(JSON.stringify(state).length).toBeLessThan(200)
  })
})

describe('expandState', () => {
  it('expands empty state to all-pending segments', () => {
    const state: BackfillState = { range, num_segments: 4, completed: [], in_flight: [] }
    const segments = expandState(state)
    expect(segments).toHaveLength(4)
    expect(segments.every((s) => s.status === 'pending' && s.page_cursor === null)).toBe(true)
    expect(segments[0].gte).toBe(0)
    expect(segments[segments.length - 1].lt).toBe(1000)
  })

  it('expands fully completed state to single complete segment', () => {
    const state: BackfillState = {
      range,
      num_segments: 4,
      completed: [{ gte: 0, lt: 1000 }],
      in_flight: [],
    }
    const segments = expandState(state)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ gte: 0, lt: 1000, status: 'complete' })
  })

  it('expands partial progress: completed + pending gap', () => {
    const state: BackfillState = {
      range: { gte: 0, lt: 1000 },
      num_segments: 4,
      completed: [{ gte: 0, lt: 500 }],
      in_flight: [],
    }
    const segments = expandState(state)
    // 1 completed + pending segments filling 500-1000
    expect(segments[0]).toMatchObject({ gte: 0, lt: 500, status: 'complete' })
    const pending = segments.filter((s) => s.status === 'pending')
    expect(pending.length).toBeGreaterThanOrEqual(1)
    expect(pending[0].gte).toBe(500)
    expect(pending[pending.length - 1].lt).toBe(1000)
  })

  it('expands in-flight segments correctly', () => {
    const state: BackfillState = {
      range: { gte: 0, lt: 1000 },
      num_segments: 4,
      completed: [{ gte: 0, lt: 250 }],
      in_flight: [{ gte: 250, lt: 500, page_cursor: 'cur_abc' }],
    }
    const segments = expandState(state)
    const complete = segments.filter((s) => s.status === 'complete')
    const inflight = segments.filter((s) => s.page_cursor !== null)
    const pending = segments.filter((s) => s.status === 'pending' && s.page_cursor === null)

    expect(complete).toHaveLength(1)
    expect(complete[0]).toMatchObject({ gte: 0, lt: 250 })
    expect(inflight).toHaveLength(1)
    expect(inflight[0]).toMatchObject({ gte: 250, lt: 500, page_cursor: 'cur_abc' })
    expect(pending.length).toBeGreaterThanOrEqual(1)
    expect(pending[0].gte).toBe(500)
  })
})

describe('compactState → expandState round-trip', () => {
  it('preserves completed ranges and in-flight cursors', () => {
    const segments = [
      seg(0, 0, 250, 'complete'),
      seg(1, 250, 500, 'complete'),
      seg(2, 500, 750, 'pending', 'cur_abc'),
      seg(3, 750, 1000, 'pending'),
    ]
    const compacted = compactState(segments, range, 4)
    const expanded = expandState(compacted)

    // completed ranges preserved
    const complete = expanded.filter((s) => s.status === 'complete')
    expect(complete).toHaveLength(1)
    expect(complete[0]).toMatchObject({ gte: 0, lt: 500 })

    // in-flight cursor preserved
    const inflight = expanded.filter((s) => s.page_cursor !== null)
    expect(inflight).toHaveLength(1)
    expect(inflight[0]).toMatchObject({ gte: 500, lt: 750, page_cursor: 'cur_abc' })

    // remaining gap is pending
    const pending = expanded.filter((s) => s.status === 'pending' && s.page_cursor === null)
    expect(pending.length).toBeGreaterThanOrEqual(1)
    expect(pending[0].gte).toBe(750)
    expect(pending[pending.length - 1].lt).toBe(1000)
  })
})

// MARK: - segmentCountFromDensity

describe('segmentCountFromDensity', () => {
  it('returns MAX_SEGMENTS (50) for zero or negative timeProgress', () => {
    expect(segmentCountFromDensity(0)).toBe(50)
    expect(segmentCountFromDensity(-1)).toBe(50)
  })

  it('returns 1 for very sparse data (timeProgress >= 1)', () => {
    expect(segmentCountFromDensity(1)).toBe(1)
    expect(segmentCountFromDensity(2)).toBe(1)
  })

  it('returns 2 for timeProgress = 0.5', () => {
    expect(segmentCountFromDensity(0.5)).toBe(2)
  })

  it('returns 10 for timeProgress = 0.1', () => {
    expect(segmentCountFromDensity(0.1)).toBe(10)
  })

  it('returns 50 for very dense data (timeProgress = 0.02)', () => {
    expect(segmentCountFromDensity(0.02)).toBe(50)
  })

  it('caps at 50 for extremely dense data', () => {
    expect(segmentCountFromDensity(0.001)).toBe(50)
  })

  it('produces smooth values without cliff edges', () => {
    const at9 = segmentCountFromDensity(0.09)
    const at10 = segmentCountFromDensity(0.1)
    const at11 = segmentCountFromDensity(0.11)
    expect(at9).toBeGreaterThanOrEqual(at10)
    expect(at10).toBeGreaterThanOrEqual(at11)
    // No jump from 10 to 50 at the boundary
    expect(at9 - at10).toBeLessThanOrEqual(2)
  })
})

// MARK: - probeAndBuildSegments

type MockListResult = { data: unknown[]; has_more: boolean }

function mockListFn(response: MockListResult) {
  return async () => response
}

describe('probeAndBuildSegments', () => {
  const probeRange = { gte: 0, lt: 1000 }

  it('returns 1 segment for an empty stream', async () => {
    const result = await probeAndBuildSegments({
      listFn: mockListFn({ data: [], has_more: false }),
      range: probeRange,
    })
    expect(result.numSegments).toBe(1)
    expect(result.segments).toHaveLength(1)
    expect(result.firstPage.data).toEqual([])
  })

  it('returns 1 segment when all data fits in one page', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `id_${i}`, created: 900 - i }))
    const result = await probeAndBuildSegments({
      listFn: mockListFn({ data: items, has_more: false }),
      range: probeRange,
    })
    expect(result.numSegments).toBe(1)
    expect(result.firstPage.data).toHaveLength(50)
  })

  it('returns few segments for sparse data', async () => {
    // last item created at 500 → timeProgress = (1000-500)/1000 = 0.5 → ceil(1/0.5) = 2
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `id_${i}`, created: 999 - i * 5 }))
    items[99] = { id: 'id_last', created: 500 }
    const result = await probeAndBuildSegments({
      listFn: mockListFn({ data: items, has_more: true }),
      range: probeRange,
    })
    expect(result.numSegments).toBe(2)
  })

  it('returns many segments for dense data', async () => {
    // last item created at 950 → timeProgress = (1000-950)/1000 = 0.05 → ceil(1/0.05) = 20
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `id_${i}`, created: 999 - i }))
    items[99] = { id: 'id_last', created: 950 }
    const result = await probeAndBuildSegments({
      listFn: mockListFn({ data: items, has_more: true }),
      range: probeRange,
    })
    expect(result.numSegments).toBe(20)
  })

  it('returns MAX_SEGMENTS (50) for extremely dense data', async () => {
    // last item created at 990 → timeProgress = (1000-990)/1000 = 0.01 → ceil(1/0.01) = 100, capped at 50
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `id_${i}`, created: 999 }))
    items[99] = { id: 'id_last', created: 990 }
    const result = await probeAndBuildSegments({
      listFn: mockListFn({ data: items, has_more: true }),
      range: probeRange,
    })
    expect(result.numSegments).toBe(50)
  })

  it('falls back to MAX_SEGMENTS when items lack created field', async () => {
    // lastItem.created is undefined → fallback to range.gte → timeProgress = (1000-0)/1000 = 1 → 1 segment
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `id_${i}` }))
    const result = await probeAndBuildSegments({
      listFn: mockListFn({ data: items, has_more: true }),
      range: probeRange,
    })
    // (range.lt - range.gte) / totalSpan = 1.0 → ceil(1/1) = 1
    expect(result.numSegments).toBe(1)
  })

  it('handles division-by-zero when range.lt === range.gte', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `id_${i}`, created: 500 }))
    const result = await probeAndBuildSegments({
      listFn: mockListFn({ data: items, has_more: true }),
      range: { gte: 1000, lt: 1000 },
    })
    expect(result.numSegments).toBe(1)
    expect(result.segments).toHaveLength(1)
  })

  it('returns the firstPage data for zero-waste consumption', async () => {
    const items = [
      { id: 'id_0', created: 999 },
      { id: 'id_1', created: 998 },
    ]
    const result = await probeAndBuildSegments({
      listFn: mockListFn({ data: items, has_more: false }),
      range: probeRange,
    })
    expect(result.firstPage.data).toEqual(items)
    expect(result.firstPage.has_more).toBe(false)
  })

  it('passes created filter in the probe call', async () => {
    const spy = async (params: unknown) => {
      const p = params as { created?: { gte: number; lt: number } }
      expect(p.created).toEqual({ gte: 0, lt: 1000 })
      return { data: [], has_more: false }
    }
    await probeAndBuildSegments({ listFn: spy, range: probeRange })
  })
})
