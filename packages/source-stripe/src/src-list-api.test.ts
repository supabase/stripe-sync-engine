import { describe, expect, it } from 'vitest'
import type { RemainingRange } from './index.js'
import { subdivideRanges } from './src-list-api.js'

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

describe('subdivideRanges', () => {
  it('passes through ranges without cursors unchanged', () => {
    const remaining: RemainingRange[] = [
      { gte: iso(0), lt: iso(60), cursor: null },
      { gte: iso(60), lt: iso(120), cursor: null },
    ]
    const map = new Map<number, number>([[0, 10]])
    expect(subdivideRanges(remaining, 10, map)).toEqual(remaining)
  })

  it('subdivides a range with cursor and lastSeenCreated into paginated head + null-cursor tail segments', () => {
    const remaining: RemainingRange[] = [{ gte: iso(0), lt: iso(120), cursor: 'cur_1' }]
    const out = subdivideRanges(remaining, 3, new Map([[0, 30]]))
    expect(out).toEqual([
      { gte: iso(0), lt: iso(30), cursor: 'cur_1' },
      { gte: iso(30), lt: iso(60), cursor: null },
      { gte: iso(60), lt: iso(90), cursor: null },
      { gte: iso(90), lt: iso(120), cursor: null },
    ])
  })

  it('caps tail segment count at maxSegments', () => {
    const remaining: RemainingRange[] = [{ gte: iso(0), lt: iso(100), cursor: 'cur_x' }]
    const out = subdivideRanges(remaining, 2, new Map([[0, 10]]))
    const tail = out.filter((r) => r.cursor === null)
    expect(tail).toHaveLength(2)
    expect(out[0]).toEqual({ gte: iso(0), lt: iso(10), cursor: 'cur_x' })
    expect(tail[0]).toEqual({ gte: iso(10), lt: iso(55), cursor: null })
    expect(tail[1]).toEqual({ gte: iso(55), lt: iso(100), cursor: null })
  })

  it('does not subdivide when splitPoint is at or past range end', () => {
    const range: RemainingRange = { gte: iso(0), lt: iso(60), cursor: 'cur_z' }
    const endUnix = 60
    expect(subdivideRanges([range], 10, new Map([[0, endUnix]]))).toEqual([range])
    expect(subdivideRanges([range], 10, new Map([[0, endUnix + 10]]))).toEqual([range])
  })

  it('handles multiple ranges: only cursor + lastSeenCreated entries subdivide', () => {
    const a: RemainingRange = { gte: iso(0), lt: iso(30), cursor: null }
    const b: RemainingRange = { gte: iso(30), lt: iso(60), cursor: 'cur_b' }
    const c: RemainingRange = { gte: iso(60), lt: iso(120), cursor: 'cur_c' }
    const out = subdivideRanges([a, b, c], 2, new Map([[2, 90]]))
    expect(out[0]).toEqual(a)
    expect(out[1]).toEqual(b)
    expect(out.slice(2)).toEqual([
      { gte: iso(60), lt: iso(90), cursor: 'cur_c' },
      { gte: iso(90), lt: iso(105), cursor: null },
      { gte: iso(105), lt: iso(120), cursor: null },
    ])
  })

  it('passes through a range with cursor but no lastSeenCreated entry', () => {
    const range: RemainingRange = { gte: iso(0), lt: iso(100), cursor: 'cur_only' }
    expect(subdivideRanges([range], 50, new Map())).toEqual([range])
  })

  it('does not over-split a single-second tail even with a large maxSegments', () => {
    const remaining: RemainingRange[] = [{ gte: iso(1000), lt: iso(1002), cursor: 'cur_tail' }]
    const out = subdivideRanges(remaining, 100, new Map([[0, 1001]]))
    expect(out).toEqual([
      { gte: iso(1000), lt: iso(1001), cursor: 'cur_tail' },
      { gte: iso(1001), lt: iso(1002), cursor: null },
    ])
  })
})
