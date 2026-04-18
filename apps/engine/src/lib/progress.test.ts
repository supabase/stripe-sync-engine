import { describe, expect, it } from 'vitest'
import type { SyncOutput } from '@stripe/sync-protocol'
import { mergeRanges, progressReducer, createProgressState, buildProgressPayload, trackProgress } from './progress.js'

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iter) out.push(item)
  return out
}

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

describe('progressReducer', () => {
  it('counts records by stream', () => {
    const state = createProgressState()
    progressReducer(state, {
      type: 'record',
      record: { stream: 'customers', data: { id: 'cus_1' }, emitted_at: '2024-01-01T00:00:00.000Z' },
    })
    progressReducer(state, {
      type: 'record',
      record: { stream: 'customers', data: { id: 'cus_2' }, emitted_at: '2024-01-01T00:00:00.000Z' },
    })
    expect(state.recordCounts.get('customers')).toBe(2)
  })

  it('returns false for records (not a trigger)', () => {
    const state = createProgressState()
    const trigger = progressReducer(state, {
      type: 'record',
      record: { stream: 'customers', data: { id: 'cus_1' }, emitted_at: '2024-01-01T00:00:00.000Z' },
    })
    expect(trigger).toBe(false)
  })

  it('returns true for source_state (is a trigger)', () => {
    const state = createProgressState()
    const trigger = progressReducer(state, {
      type: 'source_state',
      source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '1' } },
    })
    expect(trigger).toBe(true)
  })

  it('returns true for stream_status (is a trigger)', () => {
    const state = createProgressState()
    const trigger = progressReducer(state, {
      type: 'stream_status',
      stream_status: { stream: 'customers', status: 'start' },
    })
    expect(trigger).toBe(true)
  })

  it('returns true for connection_status (is a trigger)', () => {
    const state = createProgressState()
    const trigger = progressReducer(state, {
      type: 'connection_status',
      connection_status: { status: 'failed', message: 'bad key' },
    })
    expect(trigger).toBe(true)
    expect(state.connectionStatus).toMatchObject({ status: 'failed', message: 'bad key' })
  })

  it('tracks stream status transitions', () => {
    const state = createProgressState()
    progressReducer(state, { type: 'stream_status', stream_status: { stream: 'customers', status: 'start' } })
    expect(state.streamStatus.get('customers')).toBe('start')
    progressReducer(state, { type: 'stream_status', stream_status: { stream: 'customers', status: 'complete' } })
    expect(state.streamStatus.get('customers')).toBe('complete')
  })

  it('accumulates range_complete into completed_ranges', () => {
    const state = createProgressState()
    progressReducer(state, {
      type: 'stream_status',
      stream_status: { stream: 'customers', status: 'range_complete', range_complete: { gte: '2024-01', lt: '2024-06' } },
    })
    progressReducer(state, {
      type: 'stream_status',
      stream_status: { stream: 'customers', status: 'range_complete', range_complete: { gte: '2024-06', lt: '2025-01' } },
    })
    expect(state.completedRanges.get('customers')).toEqual([{ gte: '2024-01', lt: '2025-01' }])
  })

  it('tracks stream errors', () => {
    const state = createProgressState()
    progressReducer(state, {
      type: 'stream_status',
      stream_status: { stream: 'customers', status: 'error', error: 'Connection refused' },
    })
    expect(state.streamStatus.get('customers')).toBe('error')
    expect(state.streamErrors.get('customers')).toEqual([{ message: 'Connection refused' }])
  })

  it('accumulates source state into syncState', () => {
    const state = createProgressState()
    progressReducer(state, {
      type: 'source_state',
      source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'cus_5' } },
    })
    progressReducer(state, {
      type: 'source_state',
      source_state: { state_type: 'global', data: { events_cursor: 'evt_1' } },
    })
    expect(state.syncState.source.streams.customers).toEqual({ cursor: 'cus_5' })
    expect(state.syncState.source.global).toEqual({ events_cursor: 'evt_1' })
  })
})

describe('buildProgressPayload', () => {
  it('derives status as failed when connection_status is failed', () => {
    const state = createProgressState()
    state.connectionStatus = { status: 'failed', message: 'bad' }
    const payload = buildProgressPayload(state)
    expect(payload.derived.status).toBe('failed')
  })

  it('derives status as failed when any stream errored', () => {
    const state = createProgressState()
    state.streamStatus.set('customers', 'error')
    const payload = buildProgressPayload(state)
    expect(payload.derived.status).toBe('failed')
  })

  it('derives status as succeeded when all streams terminal', () => {
    const state = createProgressState()
    state.streamStatus.set('customers', 'complete')
    state.streamStatus.set('invoices', 'skip')
    const payload = buildProgressPayload(state)
    expect(payload.derived.status).toBe('succeeded')
  })

  it('derives status as started when streams are in progress', () => {
    const state = createProgressState()
    state.streamStatus.set('customers', 'start')
    const payload = buildProgressPayload(state)
    expect(payload.derived.status).toBe('started')
  })
})

describe('trackProgress', () => {
  it('emits progress after trigger messages, not after records', async () => {
    const outputs = await collect(
      trackProgress({})(
        toAsync<SyncOutput>([
          { type: 'source_state', source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '1' } } },
          { type: 'stream_status', stream_status: { stream: 'customers', status: 'start' } },
          { type: 'eof', eof: { has_more: false } },
        ])
      )
    )

    const progressMsgs = outputs.filter((m) => m.type === 'progress')
    // One after source_state, one after stream_status, one before eof
    expect(progressMsgs.length).toBe(3)
  })

  it('emits enriched EOF with run_progress and request_progress', async () => {
    const outputs = await collect(
      trackProgress({})(
        toAsync<SyncOutput>([
          { type: 'source_state', source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '2' } } },
          { type: 'stream_status', stream_status: { stream: 'customers', status: 'complete' } },
          { type: 'eof', eof: { has_more: false } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        has_more: false,
        ending_state: {
          source: { streams: { customers: { cursor: '2' } }, global: {} },
          destination: {},
        },
        run_progress: { streams: { customers: { status: 'completed' } } },
        request_progress: { streams: { customers: { status: 'completed' } } },
      },
    })
  })

  it('passes through all messages', async () => {
    const outputs = await collect(
      trackProgress({})(
        toAsync<SyncOutput>([
          { type: 'stream_status', stream_status: { stream: 'customers', status: 'start' } },
          { type: 'source_state', source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '1' } } },
          { type: 'eof', eof: { has_more: false } },
        ])
      )
    )

    const streamStatuses = outputs.filter((m) => m.type === 'stream_status')
    expect(streamStatuses).toHaveLength(1)
    const sourceStates = outputs.filter((m) => m.type === 'source_state')
    expect(sourceStates).toHaveLength(1)
  })

  it('preserves initial state in ending_state', async () => {
    const initialState = {
      source: { streams: { invoices: { cursor: 'inv_2' } }, global: {} },
      destination: { schema_version: 1 },
      sync_run: {},
    }

    const outputs = await collect(
      trackProgress({ initial_state: initialState })(
        toAsync<SyncOutput>([
          { type: 'source_state', source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'cus_1' } } },
          { type: 'eof', eof: { has_more: false } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      eof: {
        ending_state: {
          source: {
            streams: { customers: { cursor: 'cus_1' }, invoices: { cursor: 'inv_2' } },
          },
          destination: { schema_version: 1 },
        },
      },
    })
  })

  it('omits ending_state when no state received and no initial state', async () => {
    const outputs = await collect(
      trackProgress({})(toAsync<SyncOutput>([{ type: 'eof', eof: { has_more: false } }]))
    )
    const eof = outputs.find((m) => m.type === 'eof')
    expect((eof as any).eof.ending_state).toBeUndefined()
  })

  it('seeds completed_ranges from initial sync_run progress', async () => {
    const outputs = await collect(
      trackProgress({
        initial_state: {
          source: { streams: {}, global: {} },
          destination: {},
          sync_run: {
            progress: {
              started_at: '2024-01-01T00:00:00Z',
              elapsed_ms: 0,
              global_state_count: 0,
              derived: { status: 'started', records_per_second: 0, states_per_second: 0 },
              streams: {
                customers: {
                  status: 'started',
                  state_count: 0,
                  record_count: 0,
                  completed_ranges: [{ gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' }],
                },
              },
            },
          },
        },
      })(
        toAsync<SyncOutput>([
          {
            type: 'stream_status',
            stream_status: {
              stream: 'customers',
              status: 'range_complete',
              range_complete: { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
            },
          },
          { type: 'eof', eof: { has_more: false } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      eof: {
        request_progress: {
          streams: {
            customers: {
              completed_ranges: [{ gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' }],
            },
          },
        },
      },
    })
  })
})

describe('mergeRanges', () => {
  it('returns empty for empty input', () => {
    expect(mergeRanges([])).toEqual([])
  })

  it('returns single range unchanged', () => {
    const ranges = [{ gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' }]
    expect(mergeRanges(ranges)).toEqual(ranges)
  })

  it('merges adjacent ranges', () => {
    const ranges = [
      { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ]
    expect(mergeRanges(ranges)).toEqual([
      { gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ])
  })

  it('merges overlapping ranges', () => {
    const ranges = [
      { gte: '2024-01-01T00:00:00Z', lt: '2024-07-01T00:00:00Z' },
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ]
    expect(mergeRanges(ranges)).toEqual([
      { gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ])
  })

  it('keeps non-overlapping ranges separate', () => {
    const ranges = [
      { gte: '2024-01-01T00:00:00Z', lt: '2024-03-01T00:00:00Z' },
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ]
    expect(mergeRanges(ranges)).toEqual(ranges)
  })

  it('sorts and merges out-of-order ranges', () => {
    const ranges = [
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
      { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
    ]
    expect(mergeRanges(ranges)).toEqual([
      { gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ])
  })

  it('does not mutate input array', () => {
    const ranges = [
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
      { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
    ]
    const original = JSON.parse(JSON.stringify(ranges))
    mergeRanges(ranges)
    expect(ranges).toEqual(original)
  })
})
