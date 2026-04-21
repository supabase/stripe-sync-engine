import { describe, expect, it } from 'vitest'
import type { RemainingRange } from './index.js'
import { reconcileRanges, withRateLimit } from './src-list-api.js'
import type { ListFn } from '@stripe/sync-openapi'

describe('reconcileRanges', () => {
  it('returns remaining unchanged when accounted === incoming', () => {
    const remaining: RemainingRange[] = [
      { gte: '2018', lt: '2020', cursor: 'cus_abc' },
      { gte: '2022', lt: '2024', cursor: null },
    ]
    const result = reconcileRanges(
      remaining,
      { gte: '2018', lt: '2024' },
      { gte: '2018', lt: '2024' }
    )
    expect(result).toEqual(remaining)
  })

  it('drops ranges fully below new gte', () => {
    const remaining: RemainingRange[] = [
      { gte: '2018', lt: '2020', cursor: 'cus_abc' },
      { gte: '2022', lt: '2026', cursor: null },
    ]
    const result = reconcileRanges(
      remaining,
      { gte: '2018', lt: '2026' },
      { gte: '2020', lt: '2026' }
    )
    expect(result).toEqual([{ gte: '2022', lt: '2026', cursor: null }])
  })

  it('drops ranges fully above new lt', () => {
    const remaining: RemainingRange[] = [
      { gte: '2018', lt: '2020', cursor: null },
      { gte: '2024', lt: '2026', cursor: null },
    ]
    const result = reconcileRanges(
      remaining,
      { gte: '2018', lt: '2026' },
      { gte: '2018', lt: '2022' }
    )
    expect(result).toEqual([{ gte: '2018', lt: '2020', cursor: null }])
  })

  it('trims a range that overlaps the new gte and resets its cursor', () => {
    const remaining: RemainingRange[] = [{ gte: '2018', lt: '2022', cursor: 'cus_xyz' }]
    const result = reconcileRanges(
      remaining,
      { gte: '2018', lt: '2024' },
      { gte: '2020', lt: '2024' }
    )
    expect(result).toEqual([{ gte: '2020', lt: '2022', cursor: null }])
  })

  it('trims a range that overlaps the new lt but preserves its cursor', () => {
    const remaining: RemainingRange[] = [{ gte: '2022', lt: '2026', cursor: 'cus_abc' }]
    const result = reconcileRanges(
      remaining,
      { gte: '2018', lt: '2026' },
      { gte: '2018', lt: '2024' }
    )
    expect(result).toEqual([{ gte: '2022', lt: '2024', cursor: 'cus_abc' }])
  })

  it('adds uncovered territory when lt is extended', () => {
    const result = reconcileRanges([], { gte: '2018', lt: '2024' }, { gte: '2018', lt: '2026' })
    expect(result).toEqual([{ gte: '2024', lt: '2026', cursor: null }])
  })

  it('adds uncovered territory when gte is decreased', () => {
    const remaining: RemainingRange[] = [{ gte: '2022', lt: '2024', cursor: 'cus_xyz' }]
    const result = reconcileRanges(
      remaining,
      { gte: '2018', lt: '2024' },
      { gte: '2016', lt: '2024' }
    )
    expect(result).toEqual([
      { gte: '2022', lt: '2024', cursor: 'cus_xyz' },
      { gte: '2016', lt: '2018', cursor: null },
    ])
  })

  it('handles both gte decreased and lt extended simultaneously', () => {
    const remaining: RemainingRange[] = [{ gte: '2020', lt: '2022', cursor: null }]
    const result = reconcileRanges(
      remaining,
      { gte: '2018', lt: '2024' },
      { gte: '2016', lt: '2026' }
    )
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
    const result = reconcileRanges(
      remaining,
      { gte: '2016', lt: '2026' },
      { gte: '2018', lt: '2024' }
    )
    expect(result).toEqual([])
  })
})

describe('withRateLimit', () => {
  const noopRateLimiter = async () => 0

  it('passes through to listFn when no signal is provided', async () => {
    const listFn: ListFn = async () => ({ data: [{ id: '1' }], has_more: false })
    const wrapped = withRateLimit(listFn, noopRateLimiter)
    const result = await wrapped({})
    expect(result).toEqual({ data: [{ id: '1' }], has_more: false })
  })

  it('aborts a blocked listFn when signal fires', async () => {
    const ac = new AbortController()
    // listFn that blocks for 10s (simulates slow retry backoff)
    const listFn: ListFn = () =>
      new Promise((resolve) => setTimeout(() => resolve({ data: [], has_more: false }), 10_000))

    const wrapped = withRateLimit(listFn, noopRateLimiter, ac.signal)
    const promise = wrapped({})

    // Abort after 10ms
    setTimeout(() => ac.abort(), 10)

    await expect(promise).rejects.toThrow()
    // Should resolve nearly instantly, not after 10s
  })

  it('throws immediately if signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()

    const listFn: ListFn = async () => ({ data: [], has_more: false })
    const wrapped = withRateLimit(listFn, noopRateLimiter, ac.signal)

    await expect(wrapped({})).rejects.toThrow()
  })

  it('does not interfere with listFn errors when signal is present', async () => {
    const ac = new AbortController()
    const listFn: ListFn = async () => {
      throw new Error('API error')
    }
    const wrapped = withRateLimit(listFn, noopRateLimiter, ac.signal)

    await expect(wrapped({})).rejects.toThrow('API error')
  })
})
