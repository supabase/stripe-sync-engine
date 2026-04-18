import type {
  Message,
  SyncState,
  SyncOutput,
  StreamStatusPayload,
  TraceError,
  EofStreamProgress,
} from '@stripe/sync-protocol'
import { emptySyncState, createEngineMessageFactory } from '@stripe/sync-protocol'

const msg = createEngineMessageFactory()

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

type StreamError = { message: string; failure_type?: TraceError['failure_type'] }
type Status = StreamStatusPayload['status']
type ProgressStatus = 'not_started' | 'started' | 'completed' | 'skipped' | 'errored'

function streamStatusToProgressStatus(status: Status | undefined): ProgressStatus {
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

/**
 * Shared record counter that can be tapped into the data pipeline (before the
 * destination) to count records. The trackProgress() stage reads from it.
 */
export function createRecordCounter() {
  const counts = new Map<string, number>()
  return {
    counts,
    tap<T extends Message>(msgs: AsyncIterable<T>): AsyncIterable<T> {
      const self = this
      return (async function* () {
        for await (const msg of msgs) {
          if (msg.type === 'record' && 'record' in msg) {
            const stream = (msg as { record: { stream: string } }).record.stream
            self.counts.set(stream, (self.counts.get(stream) ?? 0) + 1)
          }
          yield msg
        }
      })()
    },
  }
}

export function trackProgress(opts: {
  interval_ms?: number
  initial_state?: SyncState
  initial_cumulative_counts?: Record<string, number>
  /** Shared counter fed by createRecordCounter().tap() on the data path. */
  recordCounter?: ReturnType<typeof createRecordCounter>
}): (msgs: AsyncIterable<SyncOutput>) => AsyncIterable<SyncOutput> {
  const intervalMs = opts.interval_ms ?? 2000

  return async function* (messages) {
    const initialCumulativeCounts = opts.initial_state?.engine?.streams
      ? Object.fromEntries(
          Object.entries(opts.initial_state.engine.streams)
            .map(([k, v]) => [
              k,
              (v as { cumulative_record_count?: number })?.cumulative_record_count ?? 0,
            ])
            .filter(([, v]) => typeof v === 'number' && v >= 0)
        )
      : (opts.initial_cumulative_counts ?? {})
    const cumulativeRecordCount = new Map<string, number>(Object.entries(initialCumulativeCounts))
    const prevSnapshotCounts = new Map<string, number>()
    let stateCheckpointCount = 0
    const streamStatus = new Map<string, Status>()
    const completedRanges = new Map<string, Range[]>()

    // Restore stream statuses and completed_ranges from engine state
    if (opts.initial_state?.engine?.streams) {
      for (const [stream, data] of Object.entries(opts.initial_state.engine.streams)) {
        const d = data as { status?: Status; completed_ranges?: Range[] }
        if (d?.status) streamStatus.set(stream, d.status)
        if (d?.completed_ranges && Array.isArray(d.completed_ranges)) {
          completedRanges.set(stream, d.completed_ranges.slice())
        }
      }
    }
    if (opts.initial_state?.source?.streams) {
      for (const [stream, data] of Object.entries(opts.initial_state.source.streams)) {
        const status = (data as { status?: string })?.status
        if (status) streamStatus.set(stream, status as Status)
      }
    }
    const streamErrors = new Map<string, StreamError[]>()
    let connectionStatus: { status: 'succeeded' | 'failed'; message?: string } | undefined
    const hadInitialState = opts.initial_state != null
    const finalState: SyncState = structuredClone(opts.initial_state ?? emptySyncState())

    const startedAt = Date.now()
    let lastWindowAt = startedAt
    let lastEmitAt = startedAt
    let prevWindowTotal = 0

    function elapsedMs() {
      return Date.now() - startedAt
    }

    function elapsedSec() {
      return Math.max(elapsedMs() / 1000, 0.001)
    }

    function runRecordCount(stream: string): number {
      return opts.recordCounter?.counts.get(stream) ?? 0
    }

    function totalRunRecords(): number {
      if (!opts.recordCounter) return 0
      let sum = 0
      for (const v of opts.recordCounter.counts.values()) sum += v
      return sum
    }

    function windowRecordCount(stream: string): number {
      return runRecordCount(stream) - (prevSnapshotCounts.get(stream) ?? 0)
    }

    function totalWindowRecords(): number {
      return totalRunRecords() - prevWindowTotal
    }

    function allStreams(): string[] {
      const s = new Set<string>()
      if (opts.recordCounter) {
        for (const k of opts.recordCounter.counts.keys()) s.add(k)
      }
      for (const k of cumulativeRecordCount.keys()) s.add(k)
      for (const k of streamStatus.keys()) s.add(k)
      for (const k of completedRanges.keys()) s.add(k)
      return [...s]
    }

    function snapshotWindow() {
      if (opts.recordCounter) {
        for (const [k, v] of opts.recordCounter.counts) prevSnapshotCounts.set(k, v)
      }
      prevWindowTotal = totalRunRecords()
      lastWindowAt = Date.now()
      lastEmitAt = Date.now()
    }

    function buildGlobalProgress(): SyncOutput {
      const windowDuration = Math.max((Date.now() - lastWindowAt) / 1000, 0.001)
      return {
        ...msg.progress({
          started_at: new Date(startedAt).toISOString(),
          elapsed_ms: elapsedMs(),
          global_state_count: stateCheckpointCount,
          connection_status: connectionStatus,
          derived: {
            status: 'started',
            records_per_second: totalRunRecords() / elapsedSec(),
            states_per_second: stateCheckpointCount / elapsedSec(),
          },
          streams: Object.fromEntries(
            allStreams().map((s) => [
              s,
              {
                status: streamStatusToProgressStatus(streamStatus.get(s)),
                state_count: 0, // TODO: track per-stream state count
                record_count: runRecordCount(s),
                ...(completedRanges.has(s) ? { completed_ranges: completedRanges.get(s) } : {}),
              },
            ])
          ),
        }),
        _emitted_by: 'engine',
        _ts: new Date().toISOString(),
      } as SyncOutput
    }

    function buildStreamProgress(stream: string): EofStreamProgress | undefined {
      const status = streamStatus.get(stream)
      if (!status) return undefined
      const run = runRecordCount(stream)
      const cumulative = (cumulativeRecordCount.get(stream) ?? 0) + run
      return {
        status,
        cumulative_record_count: cumulative,
        run_record_count: run,
        records_per_second: run / elapsedSec(),
        errors: streamErrors.has(stream) ? streamErrors.get(stream) : undefined,
      }
    }

    function buildAccumulatedState(): SyncState | undefined {
      for (const stream of allStreams()) {
        const run = runRecordCount(stream)
        const cumulative = (cumulativeRecordCount.get(stream) ?? 0) + run
        const existing =
          finalState.engine.streams[stream] && typeof finalState.engine.streams[stream] === 'object'
            ? (finalState.engine.streams[stream] as Record<string, unknown>)
            : {}
        finalState.engine.streams[stream] = {
          ...existing,
          cumulative_record_count: cumulative,
          ...(streamStatus.has(stream) ? { status: streamStatus.get(stream) } : {}),
          ...(completedRanges.has(stream) ? { completed_ranges: completedRanges.get(stream) } : {}),
        }
      }

      const hasAnyState =
        Object.keys(finalState.source.streams).length > 0 ||
        Object.keys(finalState.source.global).length > 0 ||
        Object.keys(finalState.destination.streams).length > 0 ||
        Object.keys(finalState.destination.global).length > 0 ||
        Object.keys(finalState.engine.streams).length > 0 ||
        Object.keys(finalState.engine.global).length > 0

      return hadInitialState || hasAnyState ? finalState : undefined
    }

    function buildEnrichedEof(
      reason: 'complete' | 'state_limit' | 'time_limit' | 'error' | 'aborted'
    ): SyncOutput {
      const windowDuration = Math.max((Date.now() - lastWindowAt) / 1000, 0.001)
      const streams = allStreams()
      const streamProgressMap: Record<string, EofStreamProgress> = {}
      for (const s of streams) {
        const sp = buildStreamProgress(s)
        if (sp) streamProgressMap[s] = sp
      }
      return {
        ...msg.eof({
          reason,
          has_more: reason !== 'complete',
          state: buildAccumulatedState(),
          global_progress: {
            elapsed_ms: elapsedMs(),
            run_record_count: totalRunRecords(),
            rows_per_second: totalRunRecords() / elapsedSec(),
            window_rows_per_second: totalWindowRecords() / windowDuration,
            state_checkpoint_count: stateCheckpointCount,
          },
          stream_progress:
            Object.keys(streamProgressMap).length > 0 ? streamProgressMap : undefined,
        }),
        _emitted_by: 'engine',
        _ts: new Date().toISOString(),
      } as SyncOutput
    }

    function* maybeEmitProgress(): Iterable<SyncOutput> {
      const now = Date.now()
      if (now - lastEmitAt < intervalMs) return

      yield buildGlobalProgress()
      snapshotWindow()
    }

    for await (const msg of messages) {
      if (msg.type === 'source_state') {
        stateCheckpointCount++
        if (msg.source_state.state_type === 'stream') {
          const stream = msg.source_state.stream
          finalState.source.streams[stream] = msg.source_state.data
          if (!streamStatus.has(stream)) streamStatus.set(stream, 'start')
        } else if (msg.source_state.state_type === 'global') {
          finalState.source.global = msg.source_state.data as Record<string, unknown>
        }
      } else if (msg.type === 'stream_status') {
        // Top-level stream_status messages (new protocol)
        const ss = msg.stream_status
        if (ss.status === 'range_complete' && 'range_complete' in ss) {
          const rc = ss.range_complete
          const existing = completedRanges.get(ss.stream) ?? []
          existing.push({ gte: rc.gte, lt: rc.lt })
          completedRanges.set(ss.stream, mergeRanges(existing))
        } else if (ss.status === 'error' && 'error' in ss) {
          streamStatus.set(ss.stream, 'complete')
          const errs = streamErrors.get(ss.stream) ?? []
          errs.push({ message: ss.error })
          streamErrors.set(ss.stream, errs)
        } else {
          streamStatus.set(ss.stream, ss.status)
        }
      } else if (msg.type === 'connection_status') {
        // Global connection failure from source during read
        connectionStatus = msg.connection_status
      } else if (msg.type === 'trace') {
        if (msg.trace.trace_type === 'error') {
          const err = msg.trace.error
          if (err.stream) {
            const errs = streamErrors.get(err.stream) ?? []
            errs.push({ message: err.message, failure_type: err.failure_type })
            streamErrors.set(err.stream, errs)
          }
        }
      }

      if (msg.type === 'eof') {
        yield buildGlobalProgress()
        yield buildEnrichedEof(msg.eof.reason)
        return
      }

      yield msg
      yield* maybeEmitProgress()
    }
  }
}
