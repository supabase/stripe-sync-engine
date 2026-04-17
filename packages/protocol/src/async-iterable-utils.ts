// Async iterable utilities — generic combinators for any AsyncIterable.
// Pure primitives — no external deps, no engine-specific imports.

/**
 * Async push/pull channel with unbounded buffer when push outpaces pull.
 *
 * **Error handling:** The channel itself never throws — it is a passive data
 * structure. Producers call `push()` and `close()`; neither can fail.
 * Errors must be handled by whoever drives the source that feeds the channel
 * (see `split` for an example).
 */
export function channel<T>(): AsyncIterable<T> & {
  push(value: T): void
  close(): void
  onReturn?: () => void | Promise<void>
} {
  let resolve: ((result: IteratorResult<T>) => void) | null = null
  let done = false
  const pending: T[] = [] // only used when push() is called before next()
  let onReturn: (() => void | Promise<void>) | undefined

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
    async return() {
      done = true
      pending.length = 0
      if (resolve) {
        const r = resolve
        resolve = null
        r({ value: undefined as any, done: true })
      }
      await onReturn?.()
      return { value: undefined as any, done: true }
    },
  }

  const api = Object.assign(iter, {
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

  Object.defineProperty(api, 'onReturn', {
    enumerable: true,
    configurable: true,
    get() {
      return onReturn
    },
    set(fn: (() => void | Promise<void>) | undefined) {
      onReturn = fn
    },
  })

  return api
}

/**
 * Create an async iterable that owns a local AbortController and aborts it
 * when the consumer stops early via return()/throw().
 */
export function withAbortOnReturn<T>(
  create: (signal: AbortSignal) => AsyncIterable<T>
): AsyncIterableIterator<T> {
  const controller = new AbortController()
  const iterator = create(controller.signal)[Symbol.asyncIterator]()

  function abortLocal() {
    if (!controller.signal.aborted) {
      controller.abort(new Error('iterator returned'))
    }
  }

  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next(value?: unknown) {
      return iterator.next(value)
    },
    async return(value?: unknown) {
      abortLocal()
      if (iterator.return) {
        return await iterator.return(value)
      }
      return { value: value as T, done: true }
    },
    async throw(error?: unknown) {
      abortLocal()
      if (iterator.throw) {
        return await iterator.throw(error)
      }
      throw error
    },
  }
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
export function merge<T>(
  ...iterables: (AsyncIterable<T> | false | null | undefined)[]
): AsyncIterableIterator<T> {
  const iterators = iterables
    .filter((x): x is AsyncIterable<T> => !!x)
    .map((it) => it[Symbol.asyncIterator]())
  const pending = new Map<number, Promise<{ index: number; result: IteratorResult<T> }>>()
  let closed = false

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

  function closeAll() {
    if (closed) return
    closed = true
    pending.clear()
    void Promise.allSettled(iterators.map((it) => it.return?.()))
  }

  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      if (closed) {
        return { value: undefined as T, done: true }
      }

      while (pending.size > 0) {
        try {
          const { index, result } = await Promise.race(pending.values())
          pending.delete(index)
          if (result.done) {
            continue
          }
          enqueue(index)
          return { value: result.value, done: false }
        } catch (error) {
          closeAll()
          throw error
        }
      }

      closed = true
      return { value: undefined as T, done: true }
    },
    async return(value?: unknown) {
      closeAll()
      return { value: value as T, done: true }
    },
    async throw(error?: unknown) {
      closeAll()
      throw error
    },
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
  const sourceIterator = iterable[Symbol.asyncIterator]()
  const matches = channel<U>()
  const rest = channel<Exclude<T, U>>()

  let aborted = false
  const abort = () => {
    if (aborted) return
    aborted = true
    matches.close()
    rest.close()
    sourceIterator.return?.()
  }
  matches.onReturn = abort
  rest.onReturn = abort
  ;(async () => {
    try {
      while (true) {
        const result = await sourceIterator.next()
        if (result.done) break
        if (predicate(result.value)) {
          matches.push(result.value)
        } else {
          rest.push(result.value as Exclude<T, U>)
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
export function map<T, U>(
  iterable: AsyncIterable<T>,
  fn: (item: T) => U | Promise<U>
): AsyncIterableIterator<U> {
  const iterator = iterable[Symbol.asyncIterator]()

  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      const result = await iterator.next()
      if (result.done) {
        return { value: undefined as U, done: true }
      }
      return { value: await fn(result.value), done: false }
    },
    async return(value?: unknown) {
      if (iterator.return) {
        await iterator.return(value)
      }
      return { value: value as U, done: true }
    },
    async throw(error?: unknown) {
      if (iterator.throw) {
        const result = await iterator.throw(error)
        if (result.done) {
          return { value: undefined as U, done: true }
        }
        return { value: await fn(result.value), done: false }
      }
      throw error
    },
  }
}
