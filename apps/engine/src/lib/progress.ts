import type {
  Message,
  SyncState,
  SyncOutput,
  StreamStatusPayload,
  ProgressPayload,
} from '@stripe/sync-protocol'
import { emptySyncState, createEngineMessageFactory } from '@stripe/sync-protocol'

const engineMsg = createEngineMessageFactory()

type Range = { gte: string; lt: string }

/**
 * Merge overlapping or adjacent ISO 8601 ranges into a minimal sorted set.
 * Assumes ranges use string-comparable timestamps (ISO 8601).
 */
export function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length <= 1) return ranges.slice()
  const sorted = ranges.slice().sort((a, b) => (a.gte < b.gte ? -1 : a.gte > b.gte ? 1 : 0))
  const merged: Range[] = [{ ...sorted[0]! }]
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!
    const last = merged[merged.length - 1]!
    if (cur.gte <= last.lt) {
      last.lt = cur.lt > last.lt ? cur.lt : last.lt
    } else {
      merged.push({ ...cur })
    }
  }
  return merged
}

// MARK: - Progress state & reducer

type StreamError = { message: string }
type Status = StreamStatusPayload['status']
type ProgressStatus = 'not_started' | 'started' | 'completed' | 'skipped' | 'errored'

function statusToProgressStatus(status: Status | undefined): ProgressStatus {
  switch (status) {
    case 'start':
      return 'started'
    case 'complete':
      return 'completed'
    case 'skip':
      return 'skipped'
    case 'error':
      return 'errored'
    case 'range_complete':
      return 'started'
    default:
      return 'not_started'
  }
}

export type ProgressState = {
  startedAt: number
  stateCheckpointCount: number
  recordCounts: Map<string, number>
  streamStatus: Map<string, Status>
  completedRanges: Map<string, Range[]>
  streamErrors: Map<string, StreamError[]>
  connectionStatus?: { status: 'succeeded' | 'failed'; message?: string }
  syncState: SyncState
}

export function createProgressState(initialState?: SyncState): ProgressState {
  const state: ProgressState = {
    startedAt: Date.now(),
    stateCheckpointCount: 0,
    recordCounts: new Map(),
    streamStatus: new Map(),
    completedRanges: new Map(),
    streamErrors: new Map(),
    connectionStatus: undefined,
    syncState: structuredClone(initialState ?? emptySyncState()),
  }

  // Restore completed ranges from prior run
  const priorProgress = initialState?.sync_run?.progress
  if (priorProgress?.streams) {
    for (const [stream, sp] of Object.entries(priorProgress.streams)) {
      if (sp.completed_ranges) {
        state.completedRanges.set(stream, sp.completed_ranges.slice())
      }
    }
  }

  return state
}

/**
 * Pure reducer: apply a message to progress state. Returns whether this message
 * is a progress trigger (i.e., the caller should emit a progress snapshot).
 */
export function progressReducer(state: ProgressState, msg: Message): boolean {
  switch (msg.type) {
    case 'record': {
      const stream = (msg as { record: { stream: string } }).record.stream
      state.recordCounts.set(stream, (state.recordCounts.get(stream) ?? 0) + 1)
      return false
    }

    case 'source_state': {
      state.stateCheckpointCount++
      if (msg.source_state.state_type === 'stream') {
        const stream = msg.source_state.stream
        state.syncState.source.streams[stream] = msg.source_state.data
        if (!state.streamStatus.has(stream)) state.streamStatus.set(stream, 'start')
      } else if (msg.source_state.state_type === 'global') {
        state.syncState.source.global = msg.source_state.data as Record<string, unknown>
      }
      return true
    }

    case 'stream_status': {
      const ss = msg.stream_status
      if (ss.status === 'range_complete' && 'range_complete' in ss) {
        const rc = ss.range_complete
        const existing = state.completedRanges.get(ss.stream) ?? []
        existing.push({ gte: rc.gte, lt: rc.lt })
        state.completedRanges.set(ss.stream, mergeRanges(existing))
      } else if (ss.status === 'error' && 'error' in ss) {
        state.streamStatus.set(ss.stream, 'error')
        const errs = state.streamErrors.get(ss.stream) ?? []
        errs.push({ message: ss.error })
        state.streamErrors.set(ss.stream, errs)
      } else {
        state.streamStatus.set(ss.stream, ss.status)
      }
      return true
    }

    case 'connection_status': {
      state.connectionStatus = msg.connection_status
      return true
    }

    default:
      return false
  }
}

// MARK: - Snapshot builders

export function buildProgressPayload(state: ProgressState): ProgressPayload {
  const elapsedMs = Date.now() - state.startedAt
  const elapsedSec = Math.max(elapsedMs / 1000, 0.001)

  let totalRecords = 0
  for (const v of state.recordCounts.values()) totalRecords += v

  const allStreams = new Set<string>()
  for (const k of state.recordCounts.keys()) allStreams.add(k)
  for (const k of state.streamStatus.keys()) allStreams.add(k)
  for (const k of state.completedRanges.keys()) allStreams.add(k)

  const hasAnyError =
    state.connectionStatus?.status === 'failed' ||
    [...state.streamStatus.values()].some((s) => s === 'error')

  const allTerminal = allStreams.size > 0 && [...allStreams].every((s) => {
    const st = state.streamStatus.get(s)
    return st === 'complete' || st === 'skip' || st === 'error'
  })

  let derivedStatus: 'started' | 'succeeded' | 'failed'
  if (hasAnyError) derivedStatus = 'failed'
  else if (allTerminal) derivedStatus = 'succeeded'
  else derivedStatus = 'started'

  return {
    started_at: new Date(state.startedAt).toISOString(),
    elapsed_ms: elapsedMs,
    global_state_count: state.stateCheckpointCount,
    connection_status: state.connectionStatus,
    derived: {
      status: derivedStatus,
      records_per_second: totalRecords / elapsedSec,
      states_per_second: state.stateCheckpointCount / elapsedSec,
    },
    streams: Object.fromEntries(
      [...allStreams].map((s) => [
        s,
        {
          status: statusToProgressStatus(state.streamStatus.get(s)),
          state_count: 0,
          record_count: state.recordCounts.get(s) ?? 0,
          ...(state.completedRanges.has(s)
            ? { completed_ranges: state.completedRanges.get(s) }
            : {}),
        },
      ])
    ),
  }
}

// MARK: - Stream operator (event-driven progress emission)

/**
 * Tracks progress and emits progress snapshots on trigger messages
 * (stream_status, connection_status, source_state). Emits eof at the end.
 */
export function trackProgress(opts: {
  initial_state?: SyncState
}): (msgs: AsyncIterable<SyncOutput>) => AsyncIterable<SyncOutput> {
  return async function* (messages) {
    const state = createProgressState(opts.initial_state)
    const hadInitialState = opts.initial_state != null

    function emitProgress(): SyncOutput {
      return {
        ...engineMsg.progress(buildProgressPayload(state)),
        _emitted_by: 'engine',
        _ts: new Date().toISOString(),
      } as SyncOutput
    }

    function buildEndingState(): SyncState | undefined {
      const hasAnyState =
        Object.keys(state.syncState.source.streams).length > 0 ||
        Object.keys(state.syncState.source.global).length > 0 ||
        Object.keys(state.syncState.destination).length > 0

      return hadInitialState || hasAnyState ? state.syncState : undefined
    }

    function emitEof(hasMore: boolean): SyncOutput {
      return {
        ...engineMsg.eof({
          has_more: hasMore,
          ending_state: buildEndingState(),
          run_progress: buildProgressPayload(state),
          request_progress: buildProgressPayload(state),
        }),
        _emitted_by: 'engine',
        _ts: new Date().toISOString(),
      } as SyncOutput
    }

    for await (const msg of messages) {
      const shouldEmitProgress = progressReducer(state, msg as Message)

      if (msg.type === 'eof') {
        yield emitProgress()
        yield emitEof(msg.eof.has_more)
        return
      }

      yield msg

      if (shouldEmitProgress) {
        yield emitProgress()
      }
    }
  }
}
