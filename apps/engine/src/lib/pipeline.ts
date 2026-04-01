import type { ConfiguredCatalog, DestinationOutput, Message } from '@stripe/sync-protocol'
import type { StateStore } from './state-store.js'
import { logger } from '../logger.js'

// MARK: - enforceCatalog

/**
 * Drop messages for streams not in the catalog and apply per-stream field filtering.
 * Passes non-data messages (log, error, stream_status, catalog) through unchanged.
 */
export function enforceCatalog(
  catalog: ConfiguredCatalog
): (msgs: AsyncIterable<Message>) => AsyncIterable<Message> {
  const streamMap = new Map(catalog.streams.map((cs) => [cs.stream.name, cs]))
  return async function* (messages) {
    for await (const msg of messages) {
      if (msg.type === 'record' || msg.type === 'state') {
        const cs = streamMap.get(msg.stream)
        if (!cs) {
          logger.error({ stream: msg.stream }, 'Unknown stream not in catalog')
          continue
        }
        yield msg
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
    if (msg.type === 'log') logger[msg.level](msg.message)
    else if (msg.type === 'error')
      logger.error({ stream: msg.stream, failure_type: msg.failure_type }, msg.message)
    else if (msg.type === 'stream_status')
      logger.info({ stream: msg.stream, status: msg.status }, 'stream_status')
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
      if (msg.type === 'state') await store.set(msg.stream, msg.data)
      yield msg
    }
  }
}

// MARK: - takeStateCheckpoints

/**
 * Stops streaming after yielding `limit` state messages (across all streams).
 * All non-state messages before and between state messages pass through.
 */
export function takeStateCheckpoints<T extends { type: string }>(
  limit: number
): (msgs: AsyncIterable<T>) => AsyncIterable<T> {
  return async function* (messages) {
    let count = 0
    for await (const msg of messages) {
      yield msg
      if (msg.type === 'state' && ++count >= limit) return
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
