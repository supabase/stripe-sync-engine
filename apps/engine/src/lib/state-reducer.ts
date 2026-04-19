import type { Message, SyncState } from '@stripe/sync-protocol'
import { createInitialProgress, progressReducer } from './progress/index.js'

// MARK: - Events

export type InitializeEvent = {
  type: 'initialize'
  stream_names: string[]
  sync_run_id?: string
}

export type StateEvent = Message | InitializeEvent

// MARK: - Reducer

/**
 * Pure reducer: (state | undefined, event) → state.
 *
 * Handles two event classes:
 * - `initialize` — creates fresh state or resets sync_run if sync_run_id changed.
 * - `Message` — accumulates source cursors and run progress.
 */
export function stateReducer(state: SyncState | undefined, event: StateEvent): SyncState {
  if (event.type === 'initialize') {
    if (!state) {
      return {
        source: { streams: {}, global: {} },
        destination: {},
        sync_run: { sync_run_id: event.sync_run_id, progress: createInitialProgress(event.stream_names) },
      }
    }
    if (event.sync_run_id && state.sync_run.sync_run_id !== event.sync_run_id) {
      return { ...state, sync_run: { sync_run_id: event.sync_run_id, progress: createInitialProgress(event.stream_names) } }
    }
    return state
  }

  // Message events require existing state
  if (!state) throw new Error('stateReducer received a message before initialize')

  // Progress accumulates on every message
  if (state.sync_run.progress) {
    state = { ...state, sync_run: { ...state.sync_run, progress: progressReducer(state.sync_run.progress, event) } }
  }

  if (event.type !== 'source_state') return state
  if (event.source_state.state_type === 'stream') {
    return {
      ...state,
      source: { ...state.source, streams: { ...state.source.streams, [event.source_state.stream]: event.source_state.data } },
    }
  }
  if (event.source_state.state_type === 'global') {
    return {
      ...state,
      source: { ...state.source, global: event.source_state.data as Record<string, unknown> },
    }
  }
  return state
}

/** Messages that should trigger a progress emission to the client. */
export function isProgressTrigger(msg: { type: string }): boolean {
  return msg.type === 'stream_status' || msg.type === 'source_state' || msg.type === 'connection_status'
}
