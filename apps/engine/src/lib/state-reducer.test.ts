import { describe, expect, it } from 'vitest'
import type { Message, SyncState } from '@stripe/sync-protocol'
import { stateReducer, isProgressTrigger } from './state-reducer.js'

const TS = '2024-01-01T00:00:01.000Z'

function init(streamNames: string[], syncRunId?: string, prior?: SyncState): SyncState {
  return stateReducer(prior, {
    type: 'initialize',
    stream_names: streamNames,
    run_id: syncRunId,
  })
}

describe('stateReducer initialize event', () => {
  it('creates fresh state with progress seeded from stream names', () => {
    const state = init(['customer', 'invoice'])
    expect(state.sync_run.progress.streams).toHaveProperty('customer')
    expect(state.sync_run.progress.streams).toHaveProperty('invoice')
    expect(state.sync_run.progress.streams['customer'].status).toBe('not_started')
    expect(state.sync_run.progress.streams['invoice'].status).toBe('not_started')
  })

  it('stamps run_id on fresh state', () => {
    const state = init(['customer'], 'run-1')
    expect(state.sync_run.run_id).toBe('run-1')
  })

  it('sets time_ceiling when run_id is provided', () => {
    const before = new Date().toISOString()
    const state = init(['customer'], 'run-1')
    const after = new Date().toISOString()
    expect(state.sync_run.time_ceiling).toBeDefined()
    expect(state.sync_run.time_ceiling! >= before).toBe(true)
    expect(state.sync_run.time_ceiling! <= after).toBe(true)
  })

  it('does not set time_ceiling when run_id is omitted', () => {
    const state = init(['customer'])
    expect(state.sync_run.time_ceiling).toBeUndefined()
  })

  it('preserves existing time_ceiling on continuation', () => {
    const prior: SyncState = {
      source: { streams: {}, global: {} },
      destination: {},
      sync_run: {
        run_id: 'run-1',
        time_ceiling: '2026-01-01T00:00:00.000Z',
        progress: {
          started_at: '2024-01-01T00:00:00Z',
          elapsed_ms: 5000,
          global_state_count: 3,
          derived: {
            status: 'started',
            records_per_second: 10,
            states_per_second: 1,
            total_record_count: 0,
            total_state_count: 0,
          },
          streams: { customer: { status: 'started', state_count: 2, record_count: 500 } },
        },
      },
    }
    const state = init(['customer'], 'run-1', prior)
    expect(state.sync_run.time_ceiling).toBe('2026-01-01T00:00:00.000Z')
  })

  it('resets progress when run_id changes', () => {
    const prior: SyncState = {
      source: { streams: { customer: { cursor: 'cus_99' } }, global: {} },
      destination: {},
      sync_run: {
        run_id: 'old-run',
        progress: {
          started_at: '2024-01-01T00:00:00Z',
          elapsed_ms: 5000,
          global_state_count: 3,
          derived: {
            status: 'started',
            records_per_second: 10,
            states_per_second: 1,
            total_record_count: 0,
            total_state_count: 0,
          },
          streams: { customer: { status: 'started', state_count: 2, record_count: 500 } },
        },
      },
    }
    const state = init(['customer'], 'new-run', prior)
    expect(state.sync_run.run_id).toBe('new-run')
    expect(state.sync_run.progress.elapsed_ms).toBe(0)
    // Source state is preserved
    expect(state.source.streams['customer']).toEqual({ cursor: 'cus_99' })
  })

  it('resets time_ceiling when run_id changes', () => {
    const prior: SyncState = {
      source: { streams: {}, global: {} },
      destination: {},
      sync_run: {
        run_id: 'old-run',
        time_ceiling: '2020-01-01T00:00:00.000Z',
        progress: {
          started_at: '2024-01-01T00:00:00Z',
          elapsed_ms: 5000,
          global_state_count: 3,
          derived: {
            status: 'started',
            records_per_second: 10,
            states_per_second: 1,
            total_record_count: 0,
            total_state_count: 0,
          },
          streams: { customer: { status: 'started', state_count: 2, record_count: 500 } },
        },
      },
    }
    const before = new Date().toISOString()
    const state = init(['customer'], 'new-run', prior)
    const after = new Date().toISOString()
    expect(state.sync_run.time_ceiling).not.toBe('2020-01-01T00:00:00.000Z')
    expect(state.sync_run.time_ceiling! >= before).toBe(true)
    expect(state.sync_run.time_ceiling! <= after).toBe(true)
  })

  it('preserves progress when run_id matches on continuation', () => {
    const prior: SyncState = {
      source: { streams: {}, global: {} },
      destination: {},
      sync_run: {
        run_id: 'same-run',
        progress: {
          started_at: '2024-01-01T00:00:00Z',
          elapsed_ms: 5000,
          global_state_count: 3,
          derived: {
            status: 'started',
            records_per_second: 10,
            states_per_second: 1,
            total_record_count: 0,
            total_state_count: 0,
          },
          streams: { customer: { status: 'started', state_count: 2, record_count: 500 } },
        },
      },
    }
    const state = init(['customer'], 'same-run', prior)
    expect(state.sync_run.progress.elapsed_ms).toBe(5000)
    expect(state.sync_run.progress.streams['customer'].record_count).toBe(500)
  })

  it('preserves the prior progress object on continuation', () => {
    const prior = init(['customer'], 'same-run')
    const next = stateReducer(prior, {
      type: 'initialize',
      stream_names: ['customer'],
      run_id: 'same-run',
    })

    expect(next.sync_run.progress).toBe(prior.sync_run.progress)
    expect(next.sync_run.run_id).toBe('same-run')
  })
})

describe('stateReducer message events', () => {
  it('accumulates stream source_state', () => {
    const state = init(['customer'])
    const msg: Message = {
      _ts: TS,
      type: 'source_state',
      source_state: { state_type: 'stream', stream: 'customer', data: { cursor: 'cus_123' } },
    }
    const next = stateReducer(state, msg)
    expect(next.source.streams['customer']).toEqual({ cursor: 'cus_123' })
  })

  it('accumulates global source_state', () => {
    const state = init(['customer'])
    const msg: Message = {
      _ts: TS,
      type: 'source_state',
      source_state: { state_type: 'global', data: { events_cursor: 'evt_abc' } },
    }
    const next = stateReducer(state, msg)
    expect(next.source.global).toEqual({ events_cursor: 'evt_abc' })
  })

  it('updates progress on record messages', () => {
    const state = init(['customer'])
    const msg: Message = {
      _ts: TS,
      type: 'record',
      record: { stream: 'customer', data: { id: 'cus_1' }, emitted_at: '2024-01-01T00:00:00Z' },
    }
    const next = stateReducer(state, msg)
    expect(next.sync_run.progress.streams['customer'].record_count).toBe(1)
  })

  it('updates progress on source_state messages', () => {
    const state = init(['customer'])
    const msg: Message = {
      _ts: TS,
      type: 'source_state',
      source_state: { state_type: 'global', data: { events_cursor: 'evt_1' } },
    }
    const next = stateReducer(state, msg)
    expect(next.sync_run.progress.global_state_count).toBe(1)
  })

  it('stores connection_status failure in progress', () => {
    const state = init(['customer'])
    const msg: Message = {
      _ts: TS,
      type: 'connection_status',
      connection_status: { status: 'failed', message: 'auth error' },
    }
    const next = stateReducer(state, msg)
    expect(next.sync_run.progress.connection_status).toEqual({
      status: 'failed',
      message: 'auth error',
    })
  })

  it('does not mutate input state', () => {
    const state = init(['customer'])
    const msg: Message = {
      _ts: TS,
      type: 'source_state',
      source_state: { state_type: 'stream', stream: 'customer', data: { cursor: 'x' } },
    }
    stateReducer(state, msg)
    expect(state.source.streams).toEqual({})
  })

  it('throws if message received before initialize', () => {
    const msg: Message = { _ts: TS, type: 'log', log: { level: 'info', message: 'hello' } }
    expect(() => stateReducer(undefined, msg)).toThrow('before initialize')
  })
})

describe('isProgressTrigger', () => {
  it('returns true for stream_status, source_state, connection_status', () => {
    expect(isProgressTrigger({ type: 'stream_status' })).toBe(true)
    expect(isProgressTrigger({ type: 'source_state' })).toBe(true)
    expect(isProgressTrigger({ type: 'connection_status' })).toBe(true)
  })

  it('returns false for other message types', () => {
    expect(isProgressTrigger({ type: 'record' })).toBe(false)
    expect(isProgressTrigger({ type: 'log' })).toBe(false)
    expect(isProgressTrigger({ type: 'eof' })).toBe(false)
  })
})
