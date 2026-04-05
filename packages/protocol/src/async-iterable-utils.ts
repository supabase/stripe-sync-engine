// Async iterable utilities — generic combinators for any AsyncIterable.
// Pure primitives — no external deps, no engine-specific imports.

/**
 * Async push/pull channel. No array buffering — uses linked promise pairs.
 *
 * **Error handling:** The channel itself never throws — it is a passive data
 * structure. Producers call `push()` and `close()`; neither can fail.
 * Errors must be handled by whoever drives the source that feeds the channel
 * (see `split` for an example).
 */
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

/**
 * Merge multiple async iterables, yielding whichever produces next.
 * Falsy entries are ignored.
 *
 * **Error handling:** If any input iterable rejects, the error propagates to
 * the consumer on the next iteration. Because `Promise.race` only settles on
 * one promise at a time, other pending `.next()` promises may reject while
 * unobserved. Each pending promise has a no-op `.catch()` attached to prevent
 * Node's unhandled-rejection detector from crashing the process — the
 * rejection is still observed when `Promise.race` settles on it next.
 */
export async function* merge<T>(
  ...iterables: (AsyncIterable<T> | false | null | undefined)[]
): AsyncIterable<T> {
  const iterators = iterables
    .filter((x): x is AsyncIterable<T> => !!x)
    .map((it) => it[Symbol.asyncIterator]())
  const pending = new Map<number, Promise<{ index: number; result: IteratorResult<T> }>>()

  const suppress = (p: Promise<unknown>) => {
    p.catch(() => {})
    return p
  }
  const enqueue = (i: number) => {
    const p = iterators[i]!.next().then((result) => ({ index: i, result }))
    suppress(p)
    pending.set(i, p)
  }

  for (const [i] of iterators.entries()) {
    enqueue(i)
  }

  while (pending.size > 0) {
    const { index, result } = await Promise.race(pending.values())
    if (result.done) {
      pending.delete(index)
    } else {
      yield result.value
      enqueue(index)
    }
  }
}

/**
 * Split an async iterable into two based on a type-guard predicate.
 * Returns [matches, rest] — both are async iterables connected by channels.
 * Consumption of either drives the source forward.
 *
 * **Error handling:** The source is consumed by a background async IIFE that
 * routes items into two channels. If the source throws, `finally` closes both
 * channels so consumers see a normal end-of-iteration. The error itself is
 * swallowed (`.catch(() => {})`) to prevent an unhandled rejection from
 * crashing the process. This is intentional: `split` has two independent
 * consumers and no single place to propagate an error to. If you need error
 * visibility, handle errors on the source *before* passing it to `split`.
 */
export function split<T, U extends T>(
  iterable: AsyncIterable<T>,
  predicate: (item: T) => item is U
): [AsyncIterable<U>, AsyncIterable<Exclude<T, U>>] {
  const matches = channel<U>()
  const rest = channel<Exclude<T, U>>()

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
  })().catch(() => {})

  return [matches, rest]
}

/**
 * Transform each item in an async iterable.
 *
 * **Error handling:** Errors propagate naturally — a throw from the source
 * iterable or from `fn` rejects the consumer's `for await` loop. No special
 * machinery is needed because `map` is a simple pass-through generator with
 * a single consumer.
 */
export async function* map<T, U>(
  iterable: AsyncIterable<T>,
  fn: (item: T) => U | Promise<U>
): AsyncIterable<U> {
  for await (const item of iterable) {
    yield await fn(item)
  }
}
