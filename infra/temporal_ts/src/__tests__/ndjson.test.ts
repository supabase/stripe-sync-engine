import { describe, expect, it } from 'vitest'
import { parseNdjsonChunks, parseNdjsonStream } from '../ndjson'

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iter) result.push(item)
  return result
}

function toChunks(lines: string[]): AsyncIterable<string> {
  return (async function* () {
    for (const line of lines) yield line
  })()
}

describe('parseNdjsonChunks', () => {
  it('parses whole lines arriving one per chunk', async () => {
    const chunks = ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n']
    expect(await collect(parseNdjsonChunks(toChunks(chunks)))).toEqual([
      { a: 1 },
      { b: 2 },
      { c: 3 },
    ])
  })

  it('handles partial lines split across chunks', async () => {
    const chunks = ['{"a"', ':1}\n{"b"', ':2}\n']
    expect(await collect(parseNdjsonChunks(toChunks(chunks)))).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('skips empty lines', async () => {
    const chunks = ['{"a":1}\n\n', '\n{"b":2}\n']
    expect(await collect(parseNdjsonChunks(toChunks(chunks)))).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('handles trailing content without final newline', async () => {
    const chunks = ['{"a":1}\n{"b":2}']
    expect(await collect(parseNdjsonChunks(toChunks(chunks)))).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('handles single chunk with multiple lines', async () => {
    const chunks = ['{"a":1}\n{"b":2}\n{"c":3}\n']
    expect(await collect(parseNdjsonChunks(toChunks(chunks)))).toEqual([
      { a: 1 },
      { b: 2 },
      { c: 3 },
    ])
  })

  it('handles a line split into single-character chunks', async () => {
    const line = '{"x":42}\n'
    const chunks = line.split('')
    expect(await collect(parseNdjsonChunks(toChunks(chunks)))).toEqual([{ x: 42 }])
  })

  it('returns empty for empty input', async () => {
    expect(await collect(parseNdjsonChunks(toChunks([])))).toEqual([])
  })
})

describe('parseNdjsonStream', () => {
  function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    })
  }

  it('parses whole lines from a ReadableStream', async () => {
    const stream = makeStream(['{"a":1}\n', '{"b":2}\n'])
    expect(await collect(parseNdjsonStream(stream))).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('handles partial lines split across chunks', async () => {
    const stream = makeStream(['{"a"', ':1}\n{"b"', ':2}\n'])
    expect(await collect(parseNdjsonStream(stream))).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('handles trailing content without final newline', async () => {
    const stream = makeStream(['{"a":1}\n{"b":2}'])
    expect(await collect(parseNdjsonStream(stream))).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('returns empty for empty stream', async () => {
    const stream = makeStream([])
    expect(await collect(parseNdjsonStream(stream))).toEqual([])
  })
})
