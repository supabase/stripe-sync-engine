import { describe, expect, it } from 'vitest'
import type { Message, SyncState } from '@stripe/sync-protocol'
import { stateReducer, isProgressTrigger } from './state-reducer.js'

function init(streamNames: string[], syncRunId?: string, prior?: SyncState): SyncState {
  return stateReducer(prior, { type: 'initialize', stream_names: streamNames, sync_run_id: syncRunId })
}

describe('stateReducer initialize event', () => {
  it('creates fresh state with progress seeded from stream names', () => {
    const state = init(['customers', 'invoices'])
    expect(state.sync_run.progress.streams).toHaveProperty('customers')
    expect(state.sync_run.progress.streams).toHaveProperty('invoices')
    expect(state.sync_run.progress.streams['customers'].status).toBe('not_started')
    expect(state.sync_run.progress.streams['invoices'].status).toBe('not_started')
  })

  it('stamps sync_run_id on fresh state', () => {
    const state = init(['customers'], 'run-1')
    expect(state.sync_run.sync_run_id).toBe('run-1')
  })

  it('resets progress when sync_run_id changes', () => {
    const prior: SyncState = {
      source: { streams: { customers: { cursor: 'cus_99' } }, global: {} },
      destination: {},
      sync_run: {
        sync_run_id: 'old-run',
        progress: {
          started_at: '2024-01-01T00:00:00Z',
          elapsed_ms: 5000,
          global_state_count: 3,
          derived: { status: 'started', records_per_second: 10, states_per_second: 1 },
          streams: { customers: { status: 'started', state_count: 2, record_count: 500 } },
        },
      },
    }
    const state = init(['customers'], 'new-run', prior)
    expect(state.sync_run.sync_run_id).toBe('new-run')
    expect(state.sync_run.progress.elapsed_ms).toBe(0)
    // Source state is preserved
    expect(state.source.streams['customers']).toEqual({ cursor: 'cus_99' })
  })

  it('preserves state when sync_run_id matches', () => {
    const prior: SyncState = {
      source: { streams: {}, global: {} },
      destination: {},
      sync_run: {
        sync_run_id: 'same-run',
        progress: {
          started_at: '2024-01-01T00:00:00Z',
          elapsed_ms: 5000,
          global_state_count: 3,
          derived: { status: 'started', records_per_second: 10, states_per_second: 1 },
          streams: { customers: { status: 'started', state_count: 2, record_count: 500 } },
        },
      },
    }
    const state = init(['customers'], 'same-run', prior)
    expect(state.sync_run.progress.elapsed_ms).toBe(5000)
    expect(state.sync_run.progress.streams['customers'].record_count).toBe(500)
  })
})

describe('stateReducer message events', () => {
  it('accumulates stream source_state', () => {
    const state = init(['customers'])
    const msg: Message = {
      type: 'source_state',
      source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'cus_123' } },
    }
    const next = stateReducer(state, msg)
    expect(next.source.streams['customers']).toEqual({ cursor: 'cus_123' })
  })

  it('accumulates global source_state', () => {
    const state = init(['customers'])
    const msg: Message = {
      type: 'source_state',
      source_state: { state_type: 'global', data: { events_cursor: 'evt_abc' } },
    }
    const next = stateReducer(state, msg)
    expect(next.source.global).toEqual({ events_cursor: 'evt_abc' })
  })

  it('updates progress on record messages', () => {
    const state = init(['customers'])
    const msg: Message = {
      type: 'record',
      record: { stream: 'customers', data: { id: 'cus_1' }, emitted_at: '2024-01-01T00:00:00Z' },
    }
    const next = stateReducer(state, msg)
    expect(next.sync_run.progress.streams['customers'].record_count).toBe(1)
  })

  it('updates progress on source_state messages', () => {
    const state = init(['customers'])
    const msg: Message = {
      type: 'source_state',
      source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'x' } },
    }
    const next = stateReducer(state, msg)
    expect(next.sync_run.progress.global_state_count).toBe(1)
  })

  it('updates progress on connection_status failure', () => {
    const state = init(['customers'])
    const msg: Message = {
      type: 'connection_status',
      connection_status: { status: 'failed', message: 'auth error' },
    }
    const next = stateReducer(state, msg)
    expect(next.sync_run.progress.derived.status).toBe('failed')
    expect(next.sync_run.progress.connection_status).toEqual({ status: 'failed', message: 'auth error' })
  })

  it('does not mutate input state', () => {
    const state = init(['customers'])
    const msg: Message = {
      type: 'source_state',
      source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'x' } },
    }
    stateReducer(state, msg)
    expect(state.source.streams).toEqual({})
  })

  it('throws if message received before initialize', () => {
    const msg: Message = { type: 'log', log: { level: 'info', message: 'hello' } }
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
