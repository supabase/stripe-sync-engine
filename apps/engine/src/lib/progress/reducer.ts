import type { Message, ProgressPayload, StreamProgress } from '@stripe/sync-protocol'
import type { Range } from './ranges.js'
import { mergeRanges } from './ranges.js'

export function createInitialProgress(streamNames?: string[]): ProgressPayload {
  const streams: Record<string, StreamProgress> = {}
  if (streamNames) {
    for (const name of streamNames) {
      streams[name] = { status: 'not_started', state_count: 0, record_count: 0 }
    }
  }
  return {
    started_at: new Date().toISOString(),
    elapsed_ms: 0,
    global_state_count: 0,
    connection_status: undefined,
    derived: { status: 'started', records_per_second: 0, states_per_second: 0 },
    streams,
  }
}

function getStream(progress: ProgressPayload, stream: string): StreamProgress {
  return progress.streams[stream] ?? { status: 'not_started', state_count: 0, record_count: 0 }
}

function deriveStatus(progress: ProgressPayload): 'started' | 'succeeded' | 'failed' {
  if (progress.connection_status?.status === 'failed') return 'failed'
  const streams = Object.values(progress.streams)
  if (streams.some((s) => s.status === 'errored')) return 'failed'
  if (
    streams.length > 0 &&
    streams.every(
      (s) => s.status === 'completed' || s.status === 'skipped' || s.status === 'errored'
    )
  ) {
    return 'succeeded'
  }
  return 'started'
}

function computeDerived(progress: ProgressPayload, elapsedMs: number): ProgressPayload['derived'] {
  const elapsedSec = Math.max(elapsedMs / 1000, 0.001)
  let totalRecords = 0
  for (const sp of Object.values(progress.streams)) totalRecords += sp.record_count
  return {
    status: deriveStatus(progress),
    records_per_second: totalRecords / elapsedSec,
    states_per_second: progress.global_state_count / elapsedSec,
  }
}

/** Pure reducer: (ProgressPayload, Message) → ProgressPayload */
export function progressReducer(progress: ProgressPayload, msg: Message): ProgressPayload {
  const elapsedMs = msg._ts
    ? new Date(msg._ts).getTime() - new Date(progress.started_at).getTime()
    : progress.elapsed_ms

  switch (msg.type) {
    case 'record': {
      const stream = (msg as { record: { stream: string } }).record.stream
      const sp = getStream(progress, stream)
      const next = {
        ...progress,
        elapsed_ms: elapsedMs,
        streams: { ...progress.streams, [stream]: { ...sp, record_count: sp.record_count + 1 } },
      }
      next.derived = computeDerived(next, elapsedMs)
      return next
    }

    case 'source_state': {
      const next = { ...progress, elapsed_ms: elapsedMs, global_state_count: progress.global_state_count + 1 }
      if (msg.source_state.state_type === 'stream') {
        const stream = msg.source_state.stream
        if (!progress.streams[stream]) {
          next.streams = {
            ...next.streams,
            [stream]: { status: 'started', state_count: 0, record_count: 0 },
          }
        }
      }
      next.derived = computeDerived(next, elapsedMs)
      return next
    }

    case 'stream_status': {
      const ss = msg.stream_status
      const sp = getStream(progress, ss.stream)

      if (ss.status === 'range_complete' && 'range_complete' in ss) {
        const rc = ss.range_complete as Range
        const existing = sp.completed_ranges ?? []
        const next = {
          ...progress,
          elapsed_ms: elapsedMs,
          streams: {
            ...progress.streams,
            [ss.stream]: { ...sp, completed_ranges: mergeRanges([...existing, rc]) },
          },
        }
        next.derived = computeDerived(next, elapsedMs)
        return next
      }

      let status: StreamProgress['status'] = sp.status
      if (ss.status === 'start') status = 'started'
      else if (ss.status === 'complete') status = 'completed'
      else if (ss.status === 'skip') status = 'skipped'
      else if (ss.status === 'error') status = 'errored'

      const next = {
        ...progress,
        elapsed_ms: elapsedMs,
        streams: { ...progress.streams, [ss.stream]: { ...sp, status } },
      }
      next.derived = computeDerived(next, elapsedMs)
      return next
    }

    case 'connection_status': {
      const next = { ...progress, elapsed_ms: elapsedMs, connection_status: msg.connection_status }
      next.derived = computeDerived(next, elapsedMs)
      return next
    }

    default:
      return progress
  }
}
