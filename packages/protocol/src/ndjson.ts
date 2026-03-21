/** Parse NDJSON from an AsyncIterable of chunks (e.g. Node process.stdin). */
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

/** Write a single JSON object as an NDJSON line to stdout. */
export function writeLine(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
