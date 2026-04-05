// Async iterable utilities for streaming message pipelines.
// Pure primitives — no external deps, no engine-specific imports.

/** Async push/pull channel. No array buffering — uses linked promise pairs. */
export function channel<T>(): AsyncIterable<T> & {
  push(value: T): void
  close(): void
} {
  let resolve: ((result: IteratorResult<T>) => void) | null = null
  let done = false
  const pending: T[] = [] // only used when push() is called before next()

  const iter: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]() {
      return iter
    },
    next() {
      if (pending.length > 0) {
        return Promise.resolve({ value: pending.shift()!, done: false })
      }
      if (done) return Promise.resolve({ value: undefined as any, done: true })
      return new Promise<IteratorResult<T>>((r) => {
        resolve = r
      })
    },
  }

  return Object.assign(iter, {
    push(value: T) {
      if (done) return
      if (resolve) {
        const r = resolve
        resolve = null
        r({ value, done: false })
      } else {
        pending.push(value)
      }
    },
    close() {
      done = true
      if (resolve) {
        const r = resolve
        resolve = null
        r({ value: undefined as any, done: true })
      }
    },
  })
}

/** Merge multiple async iterables, yielding whichever produces next. Falsy entries are ignored. */
export async function* merge<T>(
  ...iterables: (AsyncIterable<T> | false | null | undefined)[]
): AsyncIterable<T> {
  const iterators = iterables
    .filter((x): x is AsyncIterable<T> => !!x)
    .map((it) => it[Symbol.asyncIterator]())
  const pending = new Map<number, Promise<{ index: number; result: IteratorResult<T> }>>()

  for (const [i, iter] of iterators.entries()) {
    pending.set(
      i,
      iter.next().then((result) => ({ index: i, result }))
    )
  }

  while (pending.size > 0) {
    const { index, result } = await Promise.race(pending.values())
    if (result.done) {
      pending.delete(index)
    } else {
      yield result.value
      pending.set(
        index,
        iterators[index]!.next().then((result) => ({ index, result }))
      )
    }
  }
}

/**
 * Split an async iterable into two based on a type-guard predicate.
 * Returns [matches, rest] — both are async iterables connected by channels.
 * Consumption of either drives the source forward.
 */
export function split<T, U extends T>(
  iterable: AsyncIterable<T>,
  predicate: (item: T) => item is U
): [AsyncIterable<U>, AsyncIterable<Exclude<T, U>>] {
  const matches = channel<U>()
  const rest = channel<Exclude<T, U>>()

  // Drive the source in the background — routes items to the correct channel.
  ;(async () => {
    try {
      for await (const item of iterable) {
        if (predicate(item)) {
          matches.push(item)
        } else {
          rest.push(item as Exclude<T, U>)
        }
      }
    } finally {
      matches.close()
      rest.close()
    }
  })()

  return [matches, rest]
}

/** Transform each item in an async iterable. */
export async function* map<T, U>(
  iterable: AsyncIterable<T>,
  fn: (item: T) => U | Promise<U>
): AsyncIterable<U> {
  for await (const item of iterable) {
    yield await fn(item)
  }
}
