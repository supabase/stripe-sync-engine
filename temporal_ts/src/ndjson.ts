/** Parse NDJSON from an AsyncIterable of chunks (e.g. fetch response body). */
export async function* parseNdjsonChunks<T = unknown>(
  chunks: AsyncIterable<Uint8Array | string>
): AsyncIterable<T> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    // Keep the last (possibly incomplete) line in the buffer
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length > 0) {
        yield JSON.parse(trimmed) as T
      }
    }
  }
  // Handle any trailing content without final newline
  const trimmed = buffer.trim()
  if (trimmed.length > 0) {
    yield JSON.parse(trimmed) as T
  }
}

/** Parse an NDJSON ReadableStream (fetch resp.body) into an AsyncIterable. */
export async function* parseNdjsonStream<T = unknown>(
  stream: ReadableStream<Uint8Array>
): AsyncIterable<T> {
  const reader = stream.getReader()
  async function* toChunks(): AsyncIterable<Uint8Array> {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        yield value
      }
    } finally {
      reader.releaseLock()
    }
  }
  yield* parseNdjsonChunks<T>(toChunks())
}
