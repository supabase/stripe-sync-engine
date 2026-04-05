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

/**
 * Applies stream limits and emits an `eof` terminal message as the final item.
 *
 * - `state_limit`: stop after N state messages (state message boundary)
 * - `time_limit`: stop after N seconds (any message boundary)
 *
 * When both are set, whichever fires first wins. All non-matching messages
 * pass through unchanged. The last yielded item is always `{ type: 'eof', eof: { reason } }`.
 */
export function takeLimits<T extends { type: string }>(
  opts: { state_limit?: number; time_limit?: number } = {}
): (msgs: AsyncIterable<T>) => AsyncIterable<T> {
  return async function* (messages) {
    const deadline = opts.time_limit ? Date.now() + opts.time_limit * 1000 : undefined
    let stateCount = 0
    for await (const msg of messages) {
      yield msg
      if (deadline && Date.now() >= deadline) {
        yield { type: 'eof', eof: { reason: 'time_limit' } } as unknown as T
        return
      }
      if (msg.type === 'source_state' && opts.state_limit && ++stateCount >= opts.state_limit) {
        yield { type: 'eof', eof: { reason: 'state_limit' } } as unknown as T
        return
      }
    }
    yield { type: 'eof', eof: { reason: 'complete' } } as unknown as T
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
