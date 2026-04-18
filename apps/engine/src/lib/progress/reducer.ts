import type { Message, ProgressPayload, StreamProgress } from '@stripe/sync-protocol'
import type { Range } from './ranges.js'
import { mergeRanges } from './ranges.js'

export function createInitialProgress(prior?: ProgressPayload): ProgressPayload {
  const streams: Record<string, StreamProgress> = {}

  if (prior?.streams) {
    for (const [stream, sp] of Object.entries(prior.streams)) {
      streams[stream] = { ...sp }
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
  if (streams.length > 0 && streams.every((s) => s.status === 'completed' || s.status === 'skipped' || s.status === 'errored')) {
    return 'succeeded'
  }
  return 'started'
}

/** Pure reducer: (ProgressPayload, Message) → ProgressPayload */
export function progressReducer(progress: ProgressPayload, msg: Message): ProgressPayload {
  switch (msg.type) {
    case 'record': {
      const stream = (msg as { record: { stream: string } }).record.stream
      const sp = getStream(progress, stream)
      return {
        ...progress,
        streams: { ...progress.streams, [stream]: { ...sp, record_count: sp.record_count + 1 } },
      }
    }

    case 'source_state': {
      const newProgress = { ...progress, global_state_count: progress.global_state_count + 1 }
      if (msg.source_state.state_type === 'stream') {
        const stream = msg.source_state.stream
        if (!progress.streams[stream]) {
          newProgress.streams = { ...newProgress.streams, [stream]: { status: 'started', state_count: 0, record_count: 0 } }
        }
      }
      return newProgress
    }

    case 'stream_status': {
      const ss = msg.stream_status
      const sp = getStream(progress, ss.stream)

      if (ss.status === 'range_complete' && 'range_complete' in ss) {
        const rc = ss.range_complete as Range
        const existing = sp.completed_ranges ?? []
        return { ...progress, streams: { ...progress.streams, [ss.stream]: { ...sp, completed_ranges: mergeRanges([...existing, rc]) } } }
      }

      let status: StreamProgress['status'] = sp.status
      if (ss.status === 'start') status = 'started'
      else if (ss.status === 'complete') status = 'completed'
      else if (ss.status === 'skip') status = 'skipped'
      else if (ss.status === 'error') status = 'errored'

      const newSp = { ...sp, status }
      const newProgress = { ...progress, streams: { ...progress.streams, [ss.stream]: newSp } }
      newProgress.derived = { ...newProgress.derived, status: deriveStatus(newProgress) }
      return newProgress
    }

    case 'connection_status': {
      const newProgress = { ...progress, connection_status: msg.connection_status }
      newProgress.derived = { ...newProgress.derived, status: deriveStatus(newProgress) }
      return newProgress
    }

    default:
      return progress
  }
}
