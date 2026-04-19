// Async iterable utilities — generic combinators for any AsyncIterable.
// Pure primitives — no external deps, no engine-specific imports.
//
// Backpressure model:
//
// Async iterables are pull-based: a generator only advances when .next() is
// called. This gives natural backpressure — a slow consumer automatically
// pauses a fast producer. The destination drives consumption: its for-await
// loop pulls records one at a time, and the source generator only advances
// when the destination is ready. No intermediate buffering is needed.
//
// Granularity: backpressure operates at the message level, not the page level.
// A source that fetches a page of 100 records from an API holds one page in
// memory, but yields records one at a time. The pull-based flow prevents the
// source from fetching the NEXT page until the destination has consumed enough
// records from the current one.

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

/**
 * Merge multiple async generators into one, pulling from up to `concurrency`
 * generators at a time. As generators complete, new ones are pulled in from
 * the array (bounded concurrency pool).
 */
export async function* mergeAsync<T>(
  generators: AsyncGenerator<T>[],
  concurrency: number
): AsyncGenerator<T> {
  type IndexedResult = { index: number; result: IteratorResult<T, undefined> }
  const active = new Map<number, Promise<IndexedResult>>()
  let nextIndex = 0

  function pull(gen: AsyncGenerator<T>, index: number) {
    active.set(
      index,
      gen.next().then((result) => ({ index, result: result as IteratorResult<T, undefined> }))
    )
  }

  const limit = Math.min(concurrency, generators.length)
  for (let i = 0; i < limit; i++) {
    pull(generators[i], i)
    nextIndex = i + 1
  }

  while (active.size > 0) {
    const { index, result } = await Promise.race(active.values())
    active.delete(index)

    if (result.done) {
      if (nextIndex < generators.length) {
        pull(generators[nextIndex], nextIndex)
        nextIndex++
      }
    } else {
      yield result.value
      pull(generators[index], index)
    }
  }
}
