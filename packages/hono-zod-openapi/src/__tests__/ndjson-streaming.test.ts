/**
 * Documents the error-during-streaming behavior for NDJSON Hono routes.
 *
 * Key invariant: HTTP status (200) is committed in the Response constructor
 * before the ReadableStream body runs. Once the client receives the status
 * line, it cannot be changed — a mid-stream generator throw can never
 * produce a 500 at the HTTP level.
 *
 * Two outcomes depending on whether an onError callback is provided:
 *   - no onError: stream closes early (truncated body, no error line)
 *   - onError:    a final JSON error line is appended before closing
 *
 * This mirrors the implementation in packages/ts-cli/src/ndjson.ts.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'

// Minimal inline ndjsonResponse — same contract as ts-cli/src/ndjson.ts but
// without the dependency so this package stays standalone.
function ndjsonResponse<T>(iterable: AsyncIterable<T>, onError?: (err: unknown) => T): Response {
  const encoder = new TextEncoder()
  const iterator = iterable[Symbol.asyncIterator]()
  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await iterator.next()
          if (done) break
          controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'))
        }
      } catch (err) {
        if (onError) {
          controller.enqueue(encoder.encode(JSON.stringify(onError(err)) + '\n'))
        }
        // Without onError, stream closes silently — client sees truncated body
      } finally {
        controller.close()
      }
    },
    async cancel() {
      await iterator.return?.()
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}

async function readLines(res: Response): Promise<unknown[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

describe('NDJSON streaming: error after 200 is committed', () => {
  it('status is 200 even when the stream throws after yielding some items', async () => {
    const app = new Hono()

    app.get('/stream', () => {
      async function* gen() {
        yield { type: 'record', id: 1 }
        yield { type: 'record', id: 2 }
        throw new Error('database died mid-stream')
      }
      return ndjsonResponse(gen())
    })

    const res = await app.request('/stream')

    // 200 is already committed before the generator runs — cannot become 500
    expect(res.status).toBe(200)

    // Stream truncates at the throw — no error line emitted
    const lines = await readLines(res)
    expect(lines).toEqual([
      { type: 'record', id: 1 },
      { type: 'record', id: 2 },
    ])
  })

  it('with onError: appends a final error line but status is still 200', async () => {
    const app = new Hono()

    app.get('/stream', () => {
      async function* gen(): AsyncIterable<{ type: string; id?: number; error?: string }> {
        yield { type: 'record', id: 1 }
        throw new Error('kaboom')
      }
      return ndjsonResponse(gen(), (err) => ({
        type: 'error',
        error: err instanceof Error ? err.message : 'unknown',
      }))
    })

    const res = await app.request('/stream')

    expect(res.status).toBe(200)

    const lines = await readLines(res)
    expect(lines).toEqual([
      { type: 'record', id: 1 },
      { type: 'error', error: 'kaboom' },
    ])
  })

  it('without onError: first-item throw produces an empty body, still 200', async () => {
    const app = new Hono()

    app.get('/stream', () => {
      async function* gen() {
        throw new Error('immediate failure')
        // eslint-disable-next-line no-unreachable
        yield { type: 'record' }
      }
      return ndjsonResponse(gen())
    })

    const res = await app.request('/stream')

    expect(res.status).toBe(200)
    const lines = await readLines(res)
    expect(lines).toEqual([])
  })
})
