import { describe, expect, it } from 'vitest'
import type { Message, ProgressPayload } from '@stripe/sync-protocol'
import { progressReducer, createInitialProgress } from './index.js'

const DEFAULT_TS = '2024-01-01T00:00:01.000Z'
/** Add _ts to a message for testing (preserves existing _ts). */
function at<T extends Omit<Message, '_ts'>>(msg: T): T & { _ts: string } {
  return { _ts: DEFAULT_TS, ...msg } as T & { _ts: string }
}

describe('createInitialProgress', () => {
  it('creates empty progress with defaults', () => {
    const p = createInitialProgress()
    expect(p.elapsed_ms).toBe(0)
    expect(p.global_state_count).toBe(0)
    expect(p.connection_status).toBeUndefined()
    expect(p.derived.status).toBe('started')
    expect(p.derived.records_per_second).toBe(0)
    expect(p.derived.states_per_second).toBe(0)
    expect(p.streams).toEqual({})
    expect(p.started_at).toMatch(/^\d{4}-/)
  })
})

describe('progressReducer — records', () => {
  it('counts records by stream', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'record',
        record: { stream: 'customers', data: { id: '1' }, emitted_at: '2024-01-01T00:00:00.000Z' },
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'record',
        record: { stream: 'customers', data: { id: '2' }, emitted_at: '2024-01-01T00:00:00.000Z' },
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'record',
        record: { stream: 'invoices', data: { id: '1' }, emitted_at: '2024-01-01T00:00:00.000Z' },
      })
    )
    expect(p.streams['customers']?.record_count).toBe(2)
    expect(p.streams['invoices']?.record_count).toBe(1)
  })

  it('initializes stream entry on first record', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'record',
        record: { stream: 'customers', data: {}, emitted_at: '2024-01-01T00:00:00.000Z' },
      })
    )
    expect(p.streams['customers']).toBeDefined()
    expect(p.streams['customers']?.status).toBe('not_started')
  })

  it('does not mutate original state', () => {
    const p = createInitialProgress()
    const next = progressReducer(
      p,
      at({
        type: 'record',
        record: { stream: 'customers', data: {}, emitted_at: '2024-01-01T00:00:00.000Z' },
      })
    )
    expect(p.streams['customers']).toBeUndefined()
    expect(next.streams['customers']?.record_count).toBe(1)
  })
})

describe('progressReducer — source_state', () => {
  it('increments global_state_count only for global state_type', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: {} },
      })
    )
    expect(p.global_state_count).toBe(0)
    p = progressReducer(
      p,
      at({
        type: 'source_state',
        source_state: { state_type: 'global', data: { events_cursor: 1 } },
      })
    )
    expect(p.global_state_count).toBe(1)
  })

  it('increments state_count on first source_state for that stream', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: {} },
      })
    )
    expect(p.streams['customers']?.state_count).toBe(1)
    expect(p.streams['customers']?.status).toBe('not_started')
  })

  it('does not overwrite existing stream status', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'complete' },
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: {} },
      })
    )
    expect(p.streams['customers']?.status).toBe('completed')
  })

  it('does not create stream entry for global source_state', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'source_state',
        source_state: { state_type: 'global', data: { cursor: 'x' } },
      })
    )
    expect(Object.keys(p.streams)).toHaveLength(0)
    expect(p.global_state_count).toBe(1)
  })

  it('does not mutate original state', () => {
    const p = createInitialProgress()
    const next = progressReducer(
      p,
      at({
        type: 'source_state',
        source_state: { state_type: 'global', data: { events_cursor: 1 } },
      })
    )
    expect(p.global_state_count).toBe(0)
    expect(next.global_state_count).toBe(1)
  })
})

describe('progressReducer — stream_status', () => {
  it('maps start → started', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'start' },
      })
    )
    expect(p.streams['customers']?.status).toBe('started')
  })

  it('maps complete → completed', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'complete' },
      })
    )
    expect(p.streams['customers']?.status).toBe('completed')
  })

  it('maps skip → skipped', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'skip', reason: 'not available' },
      })
    )
    expect(p.streams['customers']?.status).toBe('skipped')
  })

  it('maps error → errored', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'error', error: 'forbidden' },
      })
    )
    expect(p.streams['customers']?.status).toBe('errored')
  })

  it('accumulates range_complete into completed_ranges', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: {
          stream: 'customers',
          status: 'range_complete',
          range_complete: { gte: '2024-01', lt: '2024-06' },
        },
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: {
          stream: 'customers',
          status: 'range_complete',
          range_complete: { gte: '2024-06', lt: '2025-01' },
        },
      })
    )
    expect(p.streams['customers']?.completed_ranges).toEqual([{ gte: '2024-01', lt: '2025-01' }])
  })

  it('range_complete does not change stream status', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'start' },
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: {
          stream: 'customers',
          status: 'range_complete',
          range_complete: { gte: '2024-01', lt: '2024-06' },
        },
      })
    )
    expect(p.streams['customers']?.status).toBe('started')
  })

  it('handles multiple streams independently', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'start' },
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'invoices', status: 'complete' },
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'error', error: 'x' },
      })
    )
    expect(p.streams['customers']?.status).toBe('errored')
    expect(p.streams['invoices']?.status).toBe('completed')
  })

  it('does not mutate original state', () => {
    const p = createInitialProgress()
    const next = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'start' },
      })
    )
    expect(p.streams['customers']).toBeUndefined()
    expect(next.streams['customers']?.status).toBe('started')
  })
})

describe('progressReducer — connection_status', () => {
  it('sets connection_status', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'connection_status',
        connection_status: { status: 'failed', message: 'invalid key' },
      })
    )
    expect(p.connection_status).toEqual({ status: 'failed', message: 'invalid key' })
  })

  it('does not mutate original state', () => {
    const p = createInitialProgress()
    progressReducer(
      p,
      at({
        type: 'connection_status',
        connection_status: { status: 'failed', message: 'x' },
      })
    )
    expect(p.connection_status).toBeUndefined()
  })
})

describe('progressReducer — derived.status', () => {
  it('is started by default', () => {
    const p = createInitialProgress()
    expect(p.derived.status).toBe('started')
  })

  it('is failed when connection_status is failed', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'connection_status',
        connection_status: { status: 'failed', message: 'x' },
      })
    )
    expect(p.derived.status).toBe('failed')
  })

  it('is failed when connection_status fails even with active streams', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'start' },
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'connection_status',
        connection_status: { status: 'failed', message: 'GET /v1/account (500)' },
      })
    )
    expect(p.derived.status).toBe('failed')
  })

  it('is failed when any stream errored', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'error', error: 'x' },
      })
    )
    expect(p.derived.status).toBe('failed')
  })

  it('is failed even if other streams succeeded', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'complete' },
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'invoices', status: 'error', error: 'x' },
      })
    )
    expect(p.derived.status).toBe('failed')
  })

  it('is succeeded when all streams are terminal (completed/skipped)', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'complete' },
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'invoices', status: 'skip', reason: 'n/a' },
      })
    )
    expect(p.derived.status).toBe('succeeded')
  })

  it('is started when some streams are still active', () => {
    let p = createInitialProgress()
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'complete' },
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'stream_status',
        stream_status: { stream: 'invoices', status: 'start' },
      })
    )
    expect(p.derived.status).toBe('started')
  })
})

describe('progressReducer — elapsed_ms and rates', () => {
  it('computes elapsed_ms from _ts, anchored to first message', () => {
    let p = createInitialProgress()
    // First message anchors started_at
    p = progressReducer(
      p,
      at({
        type: 'record',
        record: { stream: 'customers', data: {}, emitted_at: '2024-01-01T00:00:00.000Z' },
        _ts: '2024-01-01T00:00:00.000Z',
      })
    )
    expect(p.elapsed_ms).toBe(0)
    expect(p.started_at).toBe('2024-01-01T00:00:00.000Z')
    // Second message measures elapsed from the anchor
    p = progressReducer(
      p,
      at({
        type: 'record',
        record: { stream: 'customers', data: {}, emitted_at: '2024-01-01T00:00:00.000Z' },
        _ts: '2024-01-01T00:00:05.000Z',
      })
    )
    expect(p.elapsed_ms).toBe(5000)
  })

  it('computes records_per_second from record_count and elapsed', () => {
    let p = createInitialProgress()
    // First message anchors started_at at T+0
    p = progressReducer(
      p,
      at({
        type: 'record',
        record: { stream: 'customers', data: {}, emitted_at: '2024-01-01T00:00:00.000Z' },
        _ts: '2024-01-01T00:00:00.000Z',
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'record',
        record: { stream: 'customers', data: {}, emitted_at: '2024-01-01T00:00:00.000Z' },
        _ts: '2024-01-01T00:00:02.000Z',
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'record',
        record: { stream: 'customers', data: {}, emitted_at: '2024-01-01T00:00:00.000Z' },
        _ts: '2024-01-01T00:00:02.000Z',
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'record',
        record: { stream: 'invoices', data: {}, emitted_at: '2024-01-01T00:00:00.000Z' },
        _ts: '2024-01-01T00:00:02.000Z',
      })
    )
    // 4 records in 2 seconds = 2 rps
    expect(p.derived.records_per_second).toBe(2)
  })

  it('computes states_per_second from global_state_count and elapsed', () => {
    let p = createInitialProgress()
    // First message anchors started_at at T+0
    p = progressReducer(
      p,
      at({
        type: 'source_state',
        source_state: { state_type: 'global', data: { events_cursor: 1 } },
        _ts: '2024-01-01T00:00:00.000Z',
      })
    )
    p = progressReducer(
      p,
      at({
        type: 'source_state',
        source_state: { state_type: 'global', data: { events_cursor: 2 } },
        _ts: '2024-01-01T00:00:04.000Z',
      })
    )
    // 2 states in 4 seconds = 0.5 sps
    expect(p.derived.states_per_second).toBe(0.5)
  })

  it('throws when _ts is missing', () => {
    const p = createInitialProgress()
    expect(() =>
      progressReducer(p, {
        type: 'record',
        record: { stream: 'customers', data: {}, emitted_at: '2024-01-01T00:00:00.000Z' },
      })
    ).toThrow('missing _ts')
  })
})

describe('progressReducer — unhandled messages', () => {
  it('returns same reference for log messages', () => {
    const p = createInitialProgress()
    expect(progressReducer(p, at({ type: 'log', log: { level: 'info', message: 'hi' } }))).toBe(p)
  })
})
