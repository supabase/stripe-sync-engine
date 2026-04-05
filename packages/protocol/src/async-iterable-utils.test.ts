import { describe, it, expect } from 'vitest'
import { channel, merge, split, map } from './async-iterable-utils.js'

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) items.push(item)
  return items
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

describe('channel', () => {
  it('delivers pushed values to the async iterator', async () => {
    const ch = channel<number>()
    ch.push(1)
    ch.push(2)
    ch.push(3)
    ch.close()
    expect(await collect(ch)).toEqual([1, 2, 3])
  })

  it('resolves pending next() when push is called later', async () => {
    const ch = channel<string>()
    const p = ch[Symbol.asyncIterator]().next()
    ch.push('hello')
    const result = await p
    expect(result).toEqual({ value: 'hello', done: false })
    ch.close()
  })

  it('returns done after close with no pending values', async () => {
    const ch = channel<number>()
    ch.close()
    const result = await ch[Symbol.asyncIterator]().next()
    expect(result.done).toBe(true)
  })
})

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
})

describe('split', () => {
  it('closes both channels when source throws (no unhandled rejection)', async () => {
    async function* failing(): AsyncIterable<number> {
      yield 1
      yield 2
      throw new Error('source failed')
    }
    const isEven = (n: number): n is number => n % 2 === 0
    const [evens, odds] = split(failing(), isEven)

    // Both channels should close (the error is swallowed, but iteration ends)
    const [evenResult, oddResult] = await Promise.all([collect(evens), collect(odds)])
    expect(evenResult).toEqual([2])
    expect(oddResult).toEqual([1])
  })

  it('splits by predicate into two streams', async () => {
    const source = fromArray([1, 2, 3, 4, 5, 6])
    const isEven = (n: number): n is number => n % 2 === 0
    const [evens, odds] = split(source, isEven)

    const [evenResult, oddResult] = await Promise.all([collect(evens), collect(odds)])
    expect(evenResult).toEqual([2, 4, 6])
    expect(oddResult).toEqual([1, 3, 5])
  })

  it('handles all matching predicate', async () => {
    const source = fromArray([2, 4, 6])
    const isEven = (n: number): n is number => n % 2 === 0
    const [evens, odds] = split(source, isEven)

    const [evenResult, oddResult] = await Promise.all([collect(evens), collect(odds)])
    expect(evenResult).toEqual([2, 4, 6])
    expect(oddResult).toEqual([])
  })

  it('handles none matching predicate', async () => {
    const source = fromArray([1, 3, 5])
    const isEven = (n: number): n is number => n % 2 === 0
    const [evens, odds] = split(source, isEven)

    const [evenResult, oddResult] = await Promise.all([collect(evens), collect(odds)])
    expect(evenResult).toEqual([])
    expect(oddResult).toEqual([1, 3, 5])
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
