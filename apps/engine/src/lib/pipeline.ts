import type { ConfiguredCatalog, DestinationOutput, Message } from '@stripe/sync-protocol'
import type { StateStore } from './state-store.js'
import { logger } from '../logger.js'

// MARK: - enforceCatalog

/**
 * Drop messages for streams not in the catalog and apply per-stream field filtering.
 * Passes non-data messages (log, trace, catalog) through unchanged.
 */
export function enforceCatalog(
  catalog: ConfiguredCatalog
): (msgs: AsyncIterable<Message>) => AsyncIterable<Message> {
  const streamMap = new Map(catalog.streams.map((cs) => [cs.stream.name, cs]))
  return async function* (messages) {
    for await (const msg of messages) {
      if (msg.type === 'record') {
        const cs = streamMap.get(msg.record.stream)
        if (!cs) {
          logger.error({ stream: msg.record.stream }, 'Unknown stream not in catalog')
          continue
        }
        const props = cs.stream.json_schema?.properties as Record<string, unknown> | undefined
        if (props) {
          yield {
            ...msg,
            record: {
              ...msg.record,
              data: Object.fromEntries(
                Object.entries(msg.record.data).filter(([key]) => key in props)
              ),
            },
          }
        } else {
          yield msg
        }
      } else if (msg.type === 'source_state') {
        if (msg.source_state.state_type === 'global') {
          yield msg // global state needs no catalog validation
        } else {
          const cs = streamMap.get(msg.source_state.stream)
          if (!cs) {
            logger.error({ stream: msg.source_state.stream }, 'Unknown stream not in catalog')
            continue
          }
          yield msg
        }
      } else {
        yield msg
      }
    }
  }
}

// MARK: - log

/**
 * Tap stage: logs diagnostics to stderr and passes ALL messages through unchanged.
 */
export async function* log(messages: AsyncIterable<Message>): AsyncIterable<Message> {
  for await (const msg of messages) {
    if (msg.type === 'log') logger[msg.log.level](msg.log.message)
    else if (msg.type === 'trace') {
      if (msg.trace.trace_type === 'error') {
        logger.error(
          { stream: msg.trace.error.stream, failure_type: msg.trace.error.failure_type },
          msg.trace.error.message
        )
      } else if (msg.trace.trace_type === 'stream_status') {
        logger.info(
          { stream: msg.trace.stream_status.stream, status: msg.trace.stream_status.status },
          'stream_status'
        )
      }
    }
    yield msg
  }
}

// MARK: - filterType

/**
 * Generic type filter — narrows the Message union to only the specified types.
 */
export function filterType<T extends Message['type']>(
  ...types: T[]
): (msgs: AsyncIterable<Message>) => AsyncIterable<Extract<Message, { type: T }>> {
  const set = new Set<string>(types)
  return async function* (messages) {
    for await (const msg of messages) {
      if (set.has(msg.type)) yield msg as Extract<Message, { type: T }>
    }
  }
}

// MARK: - persistState

/**
 * Tap on DestinationOutput: persists state messages via the provided store,
 * then passes all messages through unchanged.
 */
export function persistState(
  store: StateStore
): (msgs: AsyncIterable<DestinationOutput>) => AsyncIterable<DestinationOutput> {
  return async function* (messages) {
    for await (const msg of messages) {
      if (msg.type === 'source_state') {
        if (msg.source_state.state_type === 'global') {
          await store.setGlobal(msg.source_state.data)
        } else {
          await store.set(msg.source_state.stream, msg.source_state.data)
        }
      }
      yield msg
    }
  }
}

// MARK: - takeLimits

export interface TakeLimitsOptions {
  state_limit?: number
  time_limit?: number
  signal?: AbortSignal
}

const DEADLINE_BUFFER_MS = 1000

/**
 * Applies stream limits and emits an `eof` terminal message as the final item.
 *
 * - `state_limit`: stop after N state messages (state message boundary)
 * - `time_limit`: two-phase wall-clock deadline:
 *     - **soft** (deadline − 1 s): checked between messages, graceful return
 *     - **hard** (deadline + 1 s): `Promise.race` forces return even if upstream blocks
 *   For short time limits (< 2 s) soft = hard = deadline.
 * - `signal`: external `AbortSignal` (e.g. client disconnect). When aborted the
 *   stream terminates immediately with `reason: 'aborted'`.
 *
 * When multiple limits are set, whichever fires first wins.
 * The last yielded item is always `{ type: 'eof', eof: { reason, ... } }`.
 */
export function takeLimits<T extends Message>(
  opts: TakeLimitsOptions = {}
): (msgs: AsyncIterable<T>) => AsyncIterable<T> {
  return async function* (messages) {
    const startedAt = Date.now()
    let stateCount = 0
    const recordCount = new Map<string, number>()

    const hasTimeLimit = opts.time_limit != null && opts.time_limit > 0
    const nominalDeadline = hasTimeLimit ? startedAt + opts.time_limit! * 1000 : undefined
    const softDeadline =
      nominalDeadline != null
        ? opts.time_limit! >= 2
          ? nominalDeadline - DEADLINE_BUFFER_MS
          : nominalDeadline
        : undefined
    const hardDeadline =
      nominalDeadline != null
        ? opts.time_limit! >= 2
          ? nominalDeadline + DEADLINE_BUFFER_MS
          : nominalDeadline
        : undefined

    const needsRace = hardDeadline != null || opts.signal != null

    function getRecordCount() {
      return recordCount.size > 0 ? Object.fromEntries(recordCount) : undefined
    }

    function makeEof(
      reason: 'complete' | 'state_limit' | 'time_limit' | 'aborted',
      extra?: { cutoff?: 'soft' | 'hard' }
    ): T {
      const eof: Record<string, unknown> = {
        reason,
        record_count: getRecordCount(),
      }
      if (reason === 'time_limit' && extra?.cutoff) eof.cutoff = extra.cutoff
      if (reason === 'time_limit' || reason === 'aborted') {
        eof.elapsed_ms = Date.now() - startedAt
      }
      return { type: 'eof' as const, eof } as T
    }

    // Fast path: no time limit and no signal — simple cooperative loop
    if (!needsRace) {
      for await (const msg of messages) {
        if (msg.type === 'record' && 'record' in msg) {
          const stream = (msg as any).record.stream as string
          recordCount.set(stream, (recordCount.get(stream) ?? 0) + 1)
        }
        yield msg
        if (msg.type === 'source_state' && opts.state_limit && ++stateCount >= opts.state_limit) {
          yield makeEof('state_limit')
          return
        }
      }
      yield makeEof('complete')
      return
    }

    // Slow path: manual iterator + Promise.race for hard deadline / signal
    const iterator = messages[Symbol.asyncIterator]()
    let hardTimer: ReturnType<typeof setTimeout> | undefined

    function cleanup() {
      if (hardTimer != null) clearTimeout(hardTimer)
    }

    // Create the abort promise once so we don't leak listeners per iteration
    const abortP: Promise<{ kind: 'aborted' }> | undefined = opts.signal
      ? new Promise<{ kind: 'aborted' }>((resolve) => {
          if (opts.signal!.aborted) {
            resolve({ kind: 'aborted' })
            return
          }
          opts.signal!.addEventListener('abort', () => resolve({ kind: 'aborted' }), {
            once: true,
          })
        })
      : undefined

    try {
      while (true) {
        // Check if already aborted before starting the race
        if (opts.signal?.aborted) {
          cleanup()
          logger.warn(
            { elapsed_ms: Date.now() - startedAt, event: 'SYNC_ABORTED' },
            'SYNC_ABORTED'
          )
          yield makeEof('aborted')
          await iterator.return?.(undefined)
          return
        }

        // Build the set of promises to race
        const nextP = iterator.next()
        const racers: Promise<
          | { kind: 'next'; result: IteratorResult<T> }
          | { kind: 'hard_deadline' }
          | { kind: 'aborted' }
        >[] = [nextP.then((result) => ({ kind: 'next' as const, result }))]

        if (hardDeadline != null) {
          const remainingMs = Math.max(0, hardDeadline - Date.now())
          racers.push(
            new Promise((resolve) => {
              hardTimer = setTimeout(() => resolve({ kind: 'hard_deadline' as const }), remainingMs)
            })
          )
        }

        if (abortP) racers.push(abortP)

        const winner = await Promise.race(racers)
        cleanup()

        if (winner.kind === 'hard_deadline') {
          logger.warn(
            {
              elapsed_ms: Date.now() - startedAt,
              time_limit: opts.time_limit,
              event: 'SYNC_TIME_LIMIT_HARD',
            },
            'SYNC_TIME_LIMIT_HARD'
          )
          yield makeEof('time_limit', { cutoff: 'hard' })
          // Fire-and-forget: don't await return() since the iterator may be blocked
          iterator.return?.(undefined)
          return
        }

        if (winner.kind === 'aborted') {
          logger.warn(
            { elapsed_ms: Date.now() - startedAt, event: 'SYNC_ABORTED' },
            'SYNC_ABORTED'
          )
          yield makeEof('aborted')
          iterator.return?.(undefined)
          return
        }

        // kind === 'next'
        const { result } = winner
        if (result.done) {
          yield makeEof('complete')
          return
        }

        const msg = result.value
        if (msg.type === 'record' && 'record' in msg) {
          const stream = (msg as any).record.stream as string
          recordCount.set(stream, (recordCount.get(stream) ?? 0) + 1)
        }
        yield msg

        // Check soft deadline between messages
        if (softDeadline != null && Date.now() >= softDeadline) {
          logger.warn(
            {
              elapsed_ms: Date.now() - startedAt,
              time_limit: opts.time_limit,
              event: 'SYNC_TIME_LIMIT_SOFT',
            },
            'SYNC_TIME_LIMIT_SOFT'
          )
          yield makeEof('time_limit', { cutoff: 'soft' })
          await iterator.return?.(undefined)
          return
        }

        // Check state limit
        if (msg.type === 'source_state' && opts.state_limit && ++stateCount >= opts.state_limit) {
          yield makeEof('state_limit')
          await iterator.return?.(undefined)
          return
        }
      }
    } finally {
      cleanup()
    }
  }
}

// MARK: - collect

/**
 * Identity pass-through for DestinationOutput — useful as a terminal stage.
 */
export async function* collect(
  output: AsyncIterable<DestinationOutput>
): AsyncIterable<DestinationOutput> {
  for await (const msg of output) {
    yield msg
  }
}

// MARK: - pipe

export function pipe<A>(src: AsyncIterable<A>): AsyncIterable<A>
export function pipe<A, B>(
  src: AsyncIterable<A>,
  f1: (a: AsyncIterable<A>) => AsyncIterable<B>
): AsyncIterable<B>
export function pipe<A, B, C>(
  src: AsyncIterable<A>,
  f1: (a: AsyncIterable<A>) => AsyncIterable<B>,
  f2: (a: AsyncIterable<B>) => AsyncIterable<C>
): AsyncIterable<C>
export function pipe<A, B, C, D>(
  src: AsyncIterable<A>,
  f1: (a: AsyncIterable<A>) => AsyncIterable<B>,
  f2: (a: AsyncIterable<B>) => AsyncIterable<C>,
  f3: (a: AsyncIterable<C>) => AsyncIterable<D>
): AsyncIterable<D>
export function pipe<A, B, C, D, E>(
  src: AsyncIterable<A>,
  f1: (a: AsyncIterable<A>) => AsyncIterable<B>,
  f2: (a: AsyncIterable<B>) => AsyncIterable<C>,
  f3: (a: AsyncIterable<C>) => AsyncIterable<D>,
  f4: (a: AsyncIterable<D>) => AsyncIterable<E>
): AsyncIterable<E>
export function pipe(
  src: AsyncIterable<unknown>,
  ...fns: Array<(a: AsyncIterable<unknown>) => AsyncIterable<unknown>>
): AsyncIterable<unknown> {
  return fns.reduce((acc, fn) => fn(acc), src)
}
