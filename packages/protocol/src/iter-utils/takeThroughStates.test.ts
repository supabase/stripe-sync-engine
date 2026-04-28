import { AsyncIterableX } from 'ix/asynciterable'
import { describe, expect, it, vi } from 'vitest'
import type { Message, RecordMessage, SourceStateMessage } from '../protocol.js'
import { destinationTest } from '../../../../apps/engine/src/lib/destination-test.js'
import { sourceTest } from '../../../../apps/engine/src/lib/source-test.js'
import { takeThroughStates } from './takeThroughStates.js'

function generateMessages(
  pattern: string
): [
  AsyncIterable<Message>,
  {
    next: ReturnType<typeof vi.fn>
    return: ReturnType<typeof vi.fn>
    throw: ReturnType<typeof vi.fn>
    finally: ReturnType<typeof vi.fn>
  },
] {
  const values: Message[] = []
  let recordCount = 0
  let stateCount = 0

  for (const token of pattern.split(/[\s,]+/).filter(Boolean)) {
    if (token === 'R') {
      recordCount += 1
      values.push({
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: `cus_${recordCount}` },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      } satisfies RecordMessage)
      continue
    }

    if (token === 'S') {
      stateCount += 1
      values.push({
        type: 'source_state',
        source_state: {
          state_type: 'stream',
          stream: 'customers',
          data: { cursor: `cursor_${stateCount}_${recordCount}` },
        },
      } satisfies SourceStateMessage)
      continue
    }

    throw new Error(`Unknown token in generateMessages(): ${token}`)
  }

  const spies = {
    next: vi.fn(),
    return: vi.fn(),
    throw: vi.fn(),
    finally: vi.fn(),
  }

  return [
    {
      [Symbol.asyncIterator]() {
        const baseIterator = (async function* () {
          try {
            for (const value of values) {
              yield value
            }
          } finally {
            await spies.finally()
          }
        })()[Symbol.asyncIterator]()

        return {
          async next() {
            await spies.next()
            return baseIterator.next()
          },
          async return() {
            await spies.return()
            return (await baseIterator.return?.()) ?? { done: true as const, value: undefined }
          },
          async throw(error?: unknown) {
            await spies.throw(error)
            if (baseIterator.throw) return baseIterator.throw(error)
            return Promise.reject(error)
          },
        }
      },
    },
    spies,
  ]
}

async function sync(
  sourceInput: AsyncIterable<Message>,
  stateLimit: number
): Promise<{ recordCount: number; stateCount: number }> {
  const sourceIterable = AsyncIterableX.from(
    sourceTest.read({ config: {} }, sourceInput) as AsyncIterable<Message>
  )
  const downstream = sourceIterable.pipe(
    (messages: AsyncIterable<Message>) =>
      destinationTest.write({ config: {}, catalog: {} }, messages),
    takeThroughStates(stateLimit)
  )
  let recordCount = 0
  let stateCount = 0

  for await (const message of downstream) {
    if (message.type === 'record') {
      recordCount += 1
    } else if (message.type === 'source_state') {
      stateCount += 1
    }
  }

  return { recordCount, stateCount }
}

function expectSpyCounts(
  spies: {
    next: ReturnType<typeof vi.fn>
    return: ReturnType<typeof vi.fn>
    throw: ReturnType<typeof vi.fn>
    finally: ReturnType<typeof vi.fn>
  },
  counts: { next: number; return: number; throw: number; finally: number }
) {
  expect(spies.next).toHaveBeenCalledTimes(counts.next)
  expect(spies.return).toHaveBeenCalledTimes(counts.return)
  expect(spies.throw).toHaveBeenCalledTimes(counts.throw)
  expect(spies.finally).toHaveBeenCalledTimes(counts.finally)
}

describe('generateMessages()', () => {
  it('runs finally on exhaustion and explicit close', async () => {
    const [exhaustedMessages, exhaustedSpies] = generateMessages(`
      R,S
      R,S
    `)

    let count = 0
    for await (const _message of exhaustedMessages) {
      count += 1
    }

    expect(count).toBe(4)
    expectSpyCounts(exhaustedSpies, { next: 5, return: 0, throw: 0, finally: 1 })

    const [messages, spies] = generateMessages(`
      R,S
      R,S
    `)
    const iterator = messages[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    expect(spies.next).toHaveBeenCalledTimes(1)
    expectSpyCounts(spies, { next: 1, return: 0, throw: 0, finally: 0 })

    await expect(iterator.return?.()).resolves.toMatchObject({ done: true })
    expectSpyCounts(spies, { next: 1, return: 1, throw: 0, finally: 1 })
  })

  it('runs finally when a for-await consumer throws', async () => {
    const [messages, spies] = generateMessages(`
      R,S
      R,S
    `)

    await expect(
      (async () => {
        for await (const _message of messages) {
          throw new Error('boom')
        }
      })()
    ).rejects.toThrow('boom')

    expectSpyCounts(spies, { next: 1, return: 1, throw: 0, finally: 1 })
  })
})

describe('takeThroughStates()', () => {
  it('pipes source to destination and stops after the first 3 states', async () => {
    const [messages, spies] = generateMessages(`
      R,R,S
      R,R,S
      R,R,S
      R,R,S
    `)

    await expect(sync(messages, 3)).resolves.toEqual({ recordCount: 6, stateCount: 3 })
    expectSpyCounts(spies, { next: 10, return: 1, throw: 0, finally: 1 })
  })

  it('does not truncate when the limit exceeds the available states', async () => {
    const [messages, spies] = generateMessages(`
      R,R,S
      R,R,S
      R,R,S
      R,R,S
    `)

    await expect(sync(messages, 99)).resolves.toEqual({ recordCount: 8, stateCount: 4 })
    expectSpyCounts(spies, { next: 13, return: 0, throw: 0, finally: 1 })
  })
})
