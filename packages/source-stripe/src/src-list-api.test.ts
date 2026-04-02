import { describe, expect, it } from 'vitest'
import type { SegmentState, BackfillState } from './index.js'
import { compactState, expandState } from './src-list-api.js'

const seg = (
  index: number,
  gte: number,
  lt: number,
  status: 'pending' | 'complete',
  pageCursor: string | null = null
): SegmentState => ({ index, gte, lt, pageCursor, status })

const range = { gte: 0, lt: 1000 }

describe('compactState', () => {
  it('returns empty completed/inFlight for all-pending segments', () => {
    const segments = [seg(0, 0, 500, 'pending'), seg(1, 500, 1000, 'pending')]
    const state = compactState(segments, range, 2)
    expect(state.completed).toEqual([])
    expect(state.inFlight).toEqual([])
    expect(state.range).toEqual(range)
    expect(state.numSegments).toBe(2)
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
    expect(state.inFlight).toEqual([])
  })

  it('captures in-flight segments with cursors', () => {
    const segments = [
      seg(0, 0, 500, 'complete'),
      seg(1, 500, 750, 'pending', 'cur_abc'),
      seg(2, 750, 1000, 'pending'),
    ]
    const state = compactState(segments, range, 3)
    expect(state.completed).toEqual([{ gte: 0, lt: 500 }])
    expect(state.inFlight).toEqual([{ gte: 500, lt: 750, pageCursor: 'cur_abc' }])
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
    expect(state.inFlight).toEqual([{ gte: 250, lt: 255, pageCursor: 'cur_xyz' }])
    // State JSON should be tiny
    expect(JSON.stringify(state).length).toBeLessThan(200)
  })
})

describe('expandState', () => {
  it('expands empty state to all-pending segments', () => {
    const state: BackfillState = { range, numSegments: 4, completed: [], inFlight: [] }
    const segments = expandState(state)
    expect(segments).toHaveLength(4)
    expect(segments.every((s) => s.status === 'pending' && s.pageCursor === null)).toBe(true)
    expect(segments[0].gte).toBe(0)
    expect(segments[segments.length - 1].lt).toBe(1000)
  })

  it('expands fully completed state to single complete segment', () => {
    const state: BackfillState = {
      range,
      numSegments: 4,
      completed: [{ gte: 0, lt: 1000 }],
      inFlight: [],
    }
    const segments = expandState(state)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ gte: 0, lt: 1000, status: 'complete' })
  })

  it('expands partial progress: completed + pending gap', () => {
    const state: BackfillState = {
      range: { gte: 0, lt: 1000 },
      numSegments: 4,
      completed: [{ gte: 0, lt: 500 }],
      inFlight: [],
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
      numSegments: 4,
      completed: [{ gte: 0, lt: 250 }],
      inFlight: [{ gte: 250, lt: 500, pageCursor: 'cur_abc' }],
    }
    const segments = expandState(state)
    const complete = segments.filter((s) => s.status === 'complete')
    const inflight = segments.filter((s) => s.pageCursor !== null)
    const pending = segments.filter((s) => s.status === 'pending' && s.pageCursor === null)

    expect(complete).toHaveLength(1)
    expect(complete[0]).toMatchObject({ gte: 0, lt: 250 })
    expect(inflight).toHaveLength(1)
    expect(inflight[0]).toMatchObject({ gte: 250, lt: 500, pageCursor: 'cur_abc' })
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
    const inflight = expanded.filter((s) => s.pageCursor !== null)
    expect(inflight).toHaveLength(1)
    expect(inflight[0]).toMatchObject({ gte: 500, lt: 750, pageCursor: 'cur_abc' })

    // remaining gap is pending
    const pending = expanded.filter((s) => s.status === 'pending' && s.pageCursor === null)
    expect(pending.length).toBeGreaterThanOrEqual(1)
    expect(pending[0].gte).toBe(750)
    expect(pending[pending.length - 1].lt).toBe(1000)
  })
})
