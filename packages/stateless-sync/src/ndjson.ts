/** Parse an NDJSON string into an AsyncIterable of parsed objects. */
export async function* parseNdjson<T = unknown>(text: string): AsyncIterable<T> {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) {
      yield JSON.parse(trimmed) as T
    }
  }
}
