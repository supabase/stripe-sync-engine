import * as readline from 'node:readline'

/** Read NDJSON lines from stdin. */
export async function* readStdin(): AsyncIterable<unknown> {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (line.trim()) yield JSON.parse(line)
  }
}

/** Write a single NDJSON line to stdout. */
export function writeLine(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/** Wrap an AsyncIterable into an NDJSON streaming Response (application/x-ndjson).
 *
 * If `onError` is provided, uncaught errors are mapped to a final message of
 * type `T` before closing the stream. The callback must return a valid `T` —
 * this keeps protocol-specific error shapes out of this generic helper.
 *
 * If `onCancel` is provided it is called when the ReadableStream is cancelled
 * (e.g. client disconnect under Bun.serve()). Use this to trigger an
 * AbortController that propagates through the pipeline.
 */
export function ndjsonResponse<T>(
  iterable: AsyncIterable<T>,
  opts?:
    | ((err: unknown) => T)
    | {
        onError?: (err: unknown) => T
        onCancel?: () => void
      }
): Response {
  const onError = typeof opts === 'function' ? opts : opts?.onError
  const onCancel = typeof opts === 'object' ? opts?.onCancel : undefined

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const item of iterable) {
          controller.enqueue(encoder.encode(JSON.stringify(item) + '\n'))
        }
      } catch (err) {
        if (onError) {
          controller.enqueue(encoder.encode(JSON.stringify(onError(err)) + '\n'))
        }
      } finally {
        controller.close()
      }
    },
    cancel() {
      onCancel?.()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
    },
  })
}
