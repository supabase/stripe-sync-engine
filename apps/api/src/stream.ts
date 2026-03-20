/**
 * Streaming adapters: NDJSON body parser + SSE response writer.
 */

/** Parse an NDJSON string into an AsyncIterable of parsed objects. */
export async function* parseNdjson<T = unknown>(text: string): AsyncIterable<T> {
  const lines = text.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length > 0) {
      yield JSON.parse(trimmed) as T
    }
  }
}

/** Wrap an AsyncIterable into an SSE Response (text/event-stream). */
export function sseResponse<T>(iterable: AsyncIterable<T>): Response {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const item of iterable) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`))
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`)
        )
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
