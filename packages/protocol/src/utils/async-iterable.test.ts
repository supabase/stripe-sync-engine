import { describe, it, expect } from 'vitest'
import { merge, mergeAsync, map, withAbortOnReturn } from './async-iterable.js'

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) items.push(item)
  return items
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

describe('merge', () => {
  it('merges two async iterables', async () => {
    const a = fromArray([1, 3, 5])
    const b = fromArray([2, 4, 6])
    const result = await collect(merge(a, b))
    expect(result.sort()).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('handles one empty iterable', async () => {
    const a = fromArray([1, 2, 3])
    const b = fromArray<number>([])
    const result = await collect(merge(a, b))
    expect(result.sort()).toEqual([1, 2, 3])
  })

  it('handles both empty', async () => {
    const result = await collect(merge(fromArray([]), fromArray([])))
    expect(result).toEqual([])
  })

  it('propagates rejection from one iterable without unhandled rejection', async () => {
    const good = fromArray([1, 2, 3])
    async function* bad(): AsyncIterable<number> {
      throw new Error('boom')
    }
    await expect(collect(merge(good, bad()))).rejects.toThrow('boom')
  })

  it('propagates rejection even when the failing iterable is slower', async () => {
    async function* delayed(): AsyncIterable<number> {
      yield 1
      throw new Error('delayed boom')
    }
    const result: number[] = []
    await expect(async () => {
      for await (const item of merge(fromArray([10, 20]), delayed())) {
        result.push(item)
      }
    }).rejects.toThrow('delayed boom')
    // Should have yielded some items before the error
    expect(result.length).toBeGreaterThan(0)
  })

  it('propagates return() to child iterators', async () => {
    let aClosed = false
    let bClosed = false

    const a = withAbortOnReturn((signal) =>
      (async function* () {
        try {
          yield 1
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve()
              return
            }
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        } finally {
          aClosed = true
        }
      })()
    )

    const b = withAbortOnReturn((signal) =>
      (async function* () {
        try {
          yield 2
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve()
              return
            }
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        } finally {
          bClosed = true
        }
      })()
    )

    const iter = merge(a, b)
    await iter.next()
    await iter.return?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(aClosed).toBe(true)
    expect(bClosed).toBe(true)
  })
})

describe('mergeAsync', () => {
  it('merges iterables with bounded concurrency', async () => {
    const a = fromArray([1, 3, 5])
    const b = fromArray([2, 4, 6])
    const result = await collect(mergeAsync([a, b], 2))
    expect(result.sort()).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('respects concurrency limit', async () => {
    // Track how many iterators have been started (first .next() called)
    let started = 0

    async function* tracked(id: number): AsyncIterable<number> {
      started++
      yield id
    }

    const result = await collect(mergeAsync([tracked(1), tracked(2), tracked(3)], 2))
    // All three eventually run, but only 2 should start before the first completes
    expect(result.sort()).toEqual([1, 2, 3])
    expect(started).toBe(3)
  })

  it('calls return() on child iterators when consumer stops early', async () => {
    let aClosed = false
    let bClosed = false

    const a: AsyncIterableIterator<number> = {
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        return Promise.resolve({ value: 1, done: false })
      },
      return() {
        aClosed = true
        return Promise.resolve({ value: undefined, done: true as const })
      },
    }
    const b: AsyncIterableIterator<number> = {
      [Symbol.asyncIterator]() {
        return this
      },
      next() {
        return Promise.resolve({ value: 2, done: false })
      },
      return() {
        bClosed = true
        return Promise.resolve({ value: undefined, done: true as const })
      },
    }

    const iter = mergeAsync([a, b], 2)
    const iterator = iter[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()
    await new Promise((r) => setTimeout(r, 0))

    expect(aClosed).toBe(true)
    expect(bClosed).toBe(true)
  })
})

describe('map', () => {
  it('transforms each item', async () => {
    const result = await collect(map(fromArray([1, 2, 3]), (n) => n * 2))
    expect(result).toEqual([2, 4, 6])
  })

  it('supports async transform', async () => {
    const result = await collect(map(fromArray([1, 2, 3]), async (n) => n + 10))
    expect(result).toEqual([11, 12, 13])
  })

  it('handles empty iterable', async () => {
    const result = await collect(map(fromArray([]), (n) => n))
    expect(result).toEqual([])
  })
})

describe('withAbortOnReturn', () => {
  it('aborts the local signal before awaiting inner return()', async () => {
    let abortedDuringReturn = false

    const iter = withAbortOnReturn((signal) => ({
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise<IteratorResult<number>>(() => {})
          },
          async return() {
            abortedDuringReturn = signal.aborted
            return { value: undefined, done: true }
          },
        }
      },
    }))

    const iterator = iter[Symbol.asyncIterator]()
    void iterator.next()
    await expect(iterator.return?.()).resolves.toEqual({ value: undefined, done: true })
    expect(abortedDuringReturn).toBe(true)
  })
})
