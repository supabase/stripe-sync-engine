import { describe, expect, it } from 'vitest'
import { mergeRanges, progressReducer, createInitialProgress } from './index.js'

describe('progressReducer', () => {
  it('counts records by stream', () => {
    let p = createInitialProgress()
    p = progressReducer(p, { type: 'record', record: { stream: 'customers', data: { id: 'cus_1' }, emitted_at: '2024-01-01T00:00:00.000Z' } })
    p = progressReducer(p, { type: 'record', record: { stream: 'customers', data: { id: 'cus_2' }, emitted_at: '2024-01-01T00:00:00.000Z' } })
    expect(p.streams['customers']?.record_count).toBe(2)
  })

  it('increments global_state_count on source_state', () => {
    let p = createInitialProgress()
    p = progressReducer(p, { type: 'source_state', source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '1' } } })
    expect(p.global_state_count).toBe(1)
  })

  it('marks stream as started on first source_state', () => {
    let p = createInitialProgress()
    p = progressReducer(p, { type: 'source_state', source_state: { state_type: 'stream', stream: 'customers', data: {} } })
    expect(p.streams['customers']?.status).toBe('started')
  })

  it('maps stream_status events to progress status', () => {
    let p = createInitialProgress()
    p = progressReducer(p, { type: 'stream_status', stream_status: { stream: 'customers', status: 'start' } })
    expect(p.streams['customers']?.status).toBe('started')
    p = progressReducer(p, { type: 'stream_status', stream_status: { stream: 'customers', status: 'complete' } })
    expect(p.streams['customers']?.status).toBe('completed')
  })

  it('accumulates range_complete into completed_ranges', () => {
    let p = createInitialProgress()
    p = progressReducer(p, { type: 'stream_status', stream_status: { stream: 'customers', status: 'range_complete', range_complete: { gte: '2024-01', lt: '2024-06' } } })
    p = progressReducer(p, { type: 'stream_status', stream_status: { stream: 'customers', status: 'range_complete', range_complete: { gte: '2024-06', lt: '2025-01' } } })
    expect(p.streams['customers']?.completed_ranges).toEqual([{ gte: '2024-01', lt: '2025-01' }])
  })

  it('sets errored on stream error', () => {
    let p = createInitialProgress()
    p = progressReducer(p, { type: 'stream_status', stream_status: { stream: 'customers', status: 'error', error: 'boom' } })
    expect(p.streams['customers']?.status).toBe('errored')
  })

  it('sets connection_status', () => {
    let p = createInitialProgress()
    p = progressReducer(p, { type: 'connection_status', connection_status: { status: 'failed', message: 'bad key' } })
    expect(p.connection_status).toMatchObject({ status: 'failed', message: 'bad key' })
  })

  it('derives failed when connection_status is failed', () => {
    let p = createInitialProgress()
    p = progressReducer(p, { type: 'connection_status', connection_status: { status: 'failed', message: 'x' } })
    expect(p.derived.status).toBe('failed')
  })

  it('derives failed when any stream errored', () => {
    let p = createInitialProgress()
    p = progressReducer(p, { type: 'stream_status', stream_status: { stream: 'customers', status: 'error', error: 'x' } })
    expect(p.derived.status).toBe('failed')
  })

  it('derives succeeded when all streams terminal', () => {
    let p = createInitialProgress()
    p = progressReducer(p, { type: 'stream_status', stream_status: { stream: 'customers', status: 'complete' } })
    p = progressReducer(p, { type: 'stream_status', stream_status: { stream: 'invoices', status: 'skip', reason: 'n/a' } })
    expect(p.derived.status).toBe('succeeded')
  })

  it('returns same reference for unhandled message types', () => {
    const p = createInitialProgress()
    const next = progressReducer(p, { type: 'log', log: { level: 'info', message: 'hi' } })
    expect(next).toBe(p)
  })
})

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
