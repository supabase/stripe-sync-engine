import { AsyncIterableX } from 'ix/asynciterable'
import { takeWhile } from 'ix/asynciterable/operators'
import { describe, expect, it, vi } from 'vitest'
import type { Message, RecordMessage, SourceStateMessage } from '../protocol.js'
import { destinationTest } from '../../../../apps/engine/src/lib/destination-test.js'
import { sourceTest } from '../../../../apps/engine/src/lib/source-test.js'

function generateMessages(pattern: string): [
  AsyncIterable<Message>,
  {
    next: ReturnType<typeof vi.fn>
    return: ReturnType<typeof vi.fn>
    throw: ReturnType<typeof vi.fn>
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
  }

  return [
    {
      [Symbol.asyncIterator]() {
        let index = 0
        return {
          async next() {
            await spies.next()
            if (index >= values.length) {
              return { done: true as const, value: undefined }
            }
            return { done: false as const, value: values[index++] }
          },
          async return() {
            await spies.return()
            return { done: true as const, value: undefined }
          },
          async throw(error?: unknown) {
            await spies.throw(error)
            throw error
          },
        }
      },
    },
    spies,
  ]
}

function takeLimit(
  stateLimit: number
): (messages: AsyncIterable<Message>) => AsyncIterable<Message> {
  let stateCount = 0

  return (messages: AsyncIterable<Message>) =>
    takeWhile((message: Message) => {
      if (message.type === 'source_state') {
        stateCount += 1
        return stateCount <= stateLimit
      }

      return stateCount < stateLimit
    })(messages)
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
    takeLimit(stateLimit)
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

describe('drain()', () => {
  it('pipes source to destination and stops after the first 3 states', async () => {
    const [messages, spies] = generateMessages(`
      R,R,S
      R,R,S
      R,R,S
      R,R,S
    `)

    await expect(sync(messages, 3)).resolves.toEqual({ recordCount: 6, stateCount: 3 })
    expect(spies.next).toHaveBeenCalledTimes(10)
    expect(spies.return).toHaveBeenCalledTimes(1)
    expect(spies.throw).toHaveBeenCalledTimes(0)
  })

  it('does not truncate when the limit exceeds the available states', async () => {
    const [messages, spies] = generateMessages(`
      R,R,S
      R,R,S
      R,R,S
      R,R,S
    `)

    await expect(sync(messages, 99)).resolves.toEqual({ recordCount: 8, stateCount: 4 })
    expect(spies.next).toHaveBeenCalledTimes(13)
    expect(spies.return).toHaveBeenCalledTimes(0)
    expect(spies.throw).toHaveBeenCalledTimes(0)
  })
})
