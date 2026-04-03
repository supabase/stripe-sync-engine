import createClient from 'openapi-fetch'
import type { paths } from '../__generated__/openapi.js'
import type { Engine, SetupResult } from './engine.js'
import { parseNdjsonStream, toNdjsonStream } from './ndjson.js'
import type { CheckResult, DestinationOutput, Message, PipelineConfig } from '@stripe/sync-protocol'

// openapi-typescript does not model NDJSON streaming bodies correctly:
// - /read and /sync accept an optional NDJSON body but the generated types declare `requestBody?: never`
// - /write body is typed as `Message` (a single JSON object) instead of a stream
// We use targeted `as any` casts on the POST calls for these streaming endpoints
// until the generator supports streaming request bodies.
// See: https://github.com/openapi-ts/openapi-typescript/issues/1823
type StreamPost = (path: string, init: Record<string, unknown>) => Promise<{ response: Response }>

/**
 * HTTP client that satisfies the Engine interface by delegating each method to
 * the corresponding sync engine REST endpoint.
 *
 * Uses openapi-fetch for typed JSON endpoints (/check).
 * Streaming NDJSON endpoints use `client.POST` with targeted casts due to
 * openapi-typescript generator limitations with streaming bodies.
 *
 * Usage:
 *   const engine = createRemoteEngine('http://localhost:3001', pipeline)
 *   await engine.setup()
 *   for await (const msg of engine.sync()) { ... }
 */
export function createRemoteEngine(
  engineUrl: string,
  pipeline: PipelineConfig,
  opts?: { state?: Record<string, unknown>; stateLimit?: number; timeLimit?: number }
): Engine {
  const client = createClient<paths>({ baseUrl: engineUrl })
  const ph = JSON.stringify(pipeline)

  // Cast once: streaming endpoints need untyped POST due to generator limitations (see above)
  const streamPost = client.POST as unknown as StreamPost

  function extraHeaders(): Record<string, string> {
    const h: Record<string, string> = {}
    if (opts?.state && Object.keys(opts.state).length > 0) {
      h['x-state'] = JSON.stringify(opts.state)
    }
    return h
  }

  function queryParams(): Record<string, string> {
    const q: Record<string, string> = {}
    if (opts?.stateLimit != null) q.state_limit = String(opts.stateLimit)
    if (opts?.timeLimit != null) q.time_limit = String(opts.timeLimit)
    return q
  }

  async function post(
    path: '/read' | '/write' | '/sync' | '/setup' | '/teardown',
    body?: ReadableStream<Uint8Array>
  ): Promise<Response> {
    const headers = { ...extraHeaders() }
    const { response } = await streamPost(path, {
      params: { header: { 'x-pipeline': ph }, query: queryParams() },
      parseAs: 'stream',
      headers,
      ...(body
        ? {
            body,
            bodySerializer: (b: unknown) => b,
            headers: { 'content-type': 'application/x-ndjson', ...headers },
            duplex: 'half',
          }
        : {}),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Engine ${path} failed (${response.status}): ${text}`)
    }
    return response
  }

  return {
    async setup(): Promise<SetupResult> {
      const res = await post('/setup')
      const text = await res.text()
      return text ? JSON.parse(text) : {}
    },

    async teardown() {
      await post('/teardown')
    },

    async check() {
      const { data, error } = await client.GET('/check', {
        params: { header: { 'x-pipeline': ph } },
      })
      if (error) throw new Error(`Engine /check failed: ${JSON.stringify(error)}`)
      return data as { source: CheckResult; destination: CheckResult }
    },

    async *read(input?: AsyncIterable<unknown>) {
      const body = input ? toNdjsonStream(input) : undefined
      const res = await post('/read', body)
      yield* parseNdjsonStream<Message>(res.body!)
    },

    async *write(messages: AsyncIterable<Message>) {
      const res = await post('/write', toNdjsonStream(messages))
      yield* parseNdjsonStream<DestinationOutput>(res.body!)
    },

    async *sync(input?: AsyncIterable<unknown>) {
      const body = input ? toNdjsonStream(input) : undefined
      const res = await post('/sync', body)
      yield* parseNdjsonStream<DestinationOutput>(res.body!)
    },
  }
}
