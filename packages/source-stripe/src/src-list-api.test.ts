import { describe, expect, it } from 'vitest'
import type { RemainingRange } from './index.js'
import { computeMaxSegments, reconcileRanges } from './src-list-api.js'

describe('reconcileRanges', () => {
  it('returns remaining unchanged when accounted === incoming', () => {
    const remaining: RemainingRange[] = [
      { gte: '2018', lt: '2020', cursor: 'cus_abc' },
      { gte: '2022', lt: '2024', cursor: null },
    ]
    const result = reconcileRanges(remaining, { gte: '2018', lt: '2024' }, { gte: '2018', lt: '2024' })
    expect(result).toEqual(remaining)
  })

  it('drops ranges fully below new gte', () => {
    const remaining: RemainingRange[] = [
      { gte: '2018', lt: '2020', cursor: 'cus_abc' },
      { gte: '2022', lt: '2026', cursor: null },
    ]
    const result = reconcileRanges(remaining, { gte: '2018', lt: '2026' }, { gte: '2020', lt: '2026' })
    expect(result).toEqual([{ gte: '2022', lt: '2026', cursor: null }])
  })

  it('drops ranges fully above new lt', () => {
    const remaining: RemainingRange[] = [
      { gte: '2018', lt: '2020', cursor: null },
      { gte: '2024', lt: '2026', cursor: null },
    ]
    const result = reconcileRanges(remaining, { gte: '2018', lt: '2026' }, { gte: '2018', lt: '2022' })
    expect(result).toEqual([{ gte: '2018', lt: '2020', cursor: null }])
  })

  it('trims a range that overlaps the new gte and resets its cursor', () => {
    const remaining: RemainingRange[] = [{ gte: '2018', lt: '2022', cursor: 'cus_xyz' }]
    const result = reconcileRanges(remaining, { gte: '2018', lt: '2024' }, { gte: '2020', lt: '2024' })
    expect(result).toEqual([{ gte: '2020', lt: '2022', cursor: null }])
  })

  it('trims a range that overlaps the new lt but preserves its cursor', () => {
    const remaining: RemainingRange[] = [{ gte: '2022', lt: '2026', cursor: 'cus_abc' }]
    const result = reconcileRanges(remaining, { gte: '2018', lt: '2026' }, { gte: '2018', lt: '2024' })
    expect(result).toEqual([{ gte: '2022', lt: '2024', cursor: 'cus_abc' }])
  })

  it('adds uncovered territory when lt is extended', () => {
    const result = reconcileRanges([], { gte: '2018', lt: '2024' }, { gte: '2018', lt: '2026' })
    expect(result).toEqual([{ gte: '2024', lt: '2026', cursor: null }])
  })

  it('adds uncovered territory when gte is decreased', () => {
    const remaining: RemainingRange[] = [{ gte: '2022', lt: '2024', cursor: 'cus_xyz' }]
    const result = reconcileRanges(remaining, { gte: '2018', lt: '2024' }, { gte: '2016', lt: '2024' })
    expect(result).toEqual([
      { gte: '2022', lt: '2024', cursor: 'cus_xyz' },
      { gte: '2016', lt: '2018', cursor: null },
    ])
  })

  it('handles both gte decreased and lt extended simultaneously', () => {
    const remaining: RemainingRange[] = [{ gte: '2020', lt: '2022', cursor: null }]
    const result = reconcileRanges(remaining, { gte: '2018', lt: '2024' }, { gte: '2016', lt: '2026' })
    expect(result).toEqual([
      { gte: '2020', lt: '2022', cursor: null },
      { gte: '2016', lt: '2018', cursor: null },
      { gte: '2024', lt: '2026', cursor: null },
    ])
  })

  it('handles empty remaining with extended lt', () => {
    const result = reconcileRanges([], { gte: '2018', lt: '2024' }, { gte: '2018', lt: '2026' })
    expect(result).toEqual([{ gte: '2024', lt: '2026', cursor: null }])
  })

  it('returns empty when incoming range is narrower and remaining is outside it', () => {
    const remaining: RemainingRange[] = [
      { gte: '2016', lt: '2018', cursor: null },
      { gte: '2024', lt: '2026', cursor: null },
    ]
    const result = reconcileRanges(remaining, { gte: '2016', lt: '2026' }, { gte: '2018', lt: '2024' })
    expect(result).toEqual([])
  })
})

describe('computeMaxSegments', () => {
  it('allows sequential pagination when request budget is only one page per active stream', () => {
    expect(computeMaxSegments(80, 74)).toBe(1)
    expect(computeMaxSegments(1, 1)).toBe(1)
  })

  it('grows the subdivision budget as active streams drain', () => {
    expect(computeMaxSegments(80, 20)).toBe(4)
    expect(computeMaxSegments(80, 5)).toBe(16)
  })
})
