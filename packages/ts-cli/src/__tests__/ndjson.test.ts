import { describe, expect, it } from 'vitest'
import { ndjsonResponse } from '../ndjson.js'

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

async function readLines(res: Response): Promise<unknown[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

describe('ndjsonResponse', () => {
  it('streams items as NDJSON lines', async () => {
    const res = ndjsonResponse(fromArray([{ a: 1 }, { b: 2 }]))
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
    const lines = await readLines(res)
    expect(lines).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('calls onError callback with the thrown error and emits the result', async () => {
    async function* failing(): AsyncIterable<{ type: string; msg?: string }> {
      yield { type: 'ok' }
      throw new Error('kaboom')
    }
    const res = ndjsonResponse(failing(), (err) => ({
      type: 'error',
      msg: err instanceof Error ? err.message : 'unknown',
    }))
    const lines = await readLines(res)
    expect(lines).toEqual([{ type: 'ok' }, { type: 'error', msg: 'kaboom' }])
  })

  it('silently closes the stream when no onError is provided and iterable throws', async () => {
    async function* failing(): AsyncIterable<{ type: string }> {
      yield { type: 'ok' }
      throw new Error('kaboom')
    }
    const res = ndjsonResponse(failing())
    const lines = await readLines(res)
    // Only the item before the error — no error message emitted
    expect(lines).toEqual([{ type: 'ok' }])
  })
})
