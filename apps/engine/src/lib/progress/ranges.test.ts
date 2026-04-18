import { describe, expect, it } from 'vitest'
import { mergeRanges } from './ranges.js'

describe('mergeRanges', () => {
  it('returns empty for empty input', () => {
    expect(mergeRanges([])).toEqual([])
  })

  it('merges adjacent ranges', () => {
    expect(mergeRanges([
      { gte: '2024-01', lt: '2024-06' },
      { gte: '2024-06', lt: '2025-01' },
    ])).toEqual([{ gte: '2024-01', lt: '2025-01' }])
  })

  it('keeps non-overlapping ranges separate', () => {
    const ranges = [{ gte: '2024-01', lt: '2024-03' }, { gte: '2024-06', lt: '2025-01' }]
    expect(mergeRanges(ranges)).toEqual(ranges)
  })

  it('does not mutate input', () => {
    const ranges = [{ gte: '2024-06', lt: '2025-01' }, { gte: '2024-01', lt: '2024-06' }]
    const original = JSON.parse(JSON.stringify(ranges))
    mergeRanges(ranges)
    expect(ranges).toEqual(original)
  })
})
