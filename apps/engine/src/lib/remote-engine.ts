import createClient from 'openapi-fetch'
import type { paths } from '../__generated__/openapi.js'
import type { Engine, SetupResult, SyncOpts, ConnectorInfo, ConnectorListItem } from './engine.js'
import { parseNdjsonStream, toNdjsonStream } from './ndjson.js'
import type {
  CheckResult,
  CatalogMessage,
  DestinationOutput,
  Message,
  PipelineConfig,
} from '@stripe/sync-protocol'

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
 * Uses openapi-fetch for typed JSON endpoints (/check, /discover).
 * Streaming NDJSON endpoints use `client.POST` with targeted casts due to
 * openapi-typescript generator limitations with streaming bodies.
 *
 * ### Half-duplex streaming
 *
 * Streaming endpoints (/read, /sync, /write) send the request body as a
 * `ReadableStream` with `duplex: 'half'`. This means the full request body is
 * sent before the response starts — not a simultaneous two-way stream.
 *
 * True full-duplex (piping request in while reading response out) requires
 * HTTP/2 and `duplex: 'full'`, which is non-standard and not exposed by
 * Node.js's built-in fetch (undici). See DDR-007 in docs/architecture/decisions.md.
 *
 * This is intentional and sufficient: inputs to /read and /sync are small,
 * bounded event batches. No current use case needs to stream input and output
 * concurrently. If that changes, replace the fetch-based transport here with a
 * raw HTTP/2 client for these endpoints.
 *
 * Usage:
 *   const engine = createRemoteEngine('http://localhost:3001')
 *   await engine.pipeline_setup(pipeline)
 *   for await (const msg of engine.pipeline_sync(pipeline)) { ... }
 */
export function createRemoteEngine(engineUrl: string): Engine {
  const client = createClient<paths>({ baseUrl: engineUrl })

  // Cast once: streaming endpoints need untyped POST due to generator limitations (see above)
  const streamPost = client.POST as unknown as StreamPost

  function stateHeaders(opts?: SyncOpts): Record<string, string> {
    const h: Record<string, string> = {}
    if (opts?.state && Object.keys(opts.state).length > 0) {
      h['x-state'] = JSON.stringify(opts.state)
    }
    return h
  }

  function queryParams(opts?: SyncOpts): Record<string, string> {
    const q: Record<string, string> = {}
    if (opts?.stateLimit != null) q.state_limit = String(opts.stateLimit)
    if (opts?.timeLimit != null) q.time_limit = String(opts.timeLimit)
    return q
  }

  async function post(
    path: '/read' | '/write' | '/sync' | '/setup' | '/teardown',
    pipeline: PipelineConfig,
    opts?: SyncOpts,
    body?: ReadableStream<Uint8Array>
  ): Promise<Response> {
    const ph = JSON.stringify(pipeline)
    const headers = { ...stateHeaders(opts) }
    const { response } = await streamPost(path, {
      params: { header: { 'x-pipeline': ph }, query: queryParams(opts) },
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
    async meta_sources_list(): Promise<{ data: ConnectorListItem[] }> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (client.GET as any)('/meta/sources')
      if (error) throw new Error(`Engine /meta/sources failed: ${JSON.stringify(error)}`)
      return data as { data: ConnectorListItem[] }
    },

    async meta_source(type: string): Promise<ConnectorInfo> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (client.GET as any)('/meta/sources/{type}', {
        params: { path: { type } },
      })
      if (error) throw new Error(`Engine /meta/sources/${type} failed: ${JSON.stringify(error)}`)
      return data as ConnectorInfo
    },

    async meta_destinations_list(): Promise<{ data: ConnectorListItem[] }> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (client.GET as any)('/meta/destinations')
      if (error) throw new Error(`Engine /meta/destinations failed: ${JSON.stringify(error)}`)
      return data as { data: ConnectorListItem[] }
    },

    async meta_destination(type: string): Promise<ConnectorInfo> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (client.GET as any)('/meta/destinations/{type}', {
        params: { path: { type } },
      })
      if (error)
        throw new Error(`Engine /meta/destinations/${type} failed: ${JSON.stringify(error)}`)
      return data as ConnectorInfo
    },

    async pipeline_setup(pipeline: PipelineConfig): Promise<SetupResult> {
      const res = await post('/setup', pipeline)
      const text = await res.text()
      return text ? JSON.parse(text) : {}
    },

    async pipeline_teardown(pipeline: PipelineConfig) {
      await post('/teardown', pipeline)
    },

    async pipeline_check(pipeline: PipelineConfig) {
      const { data, error } = await client.GET('/check', {
        params: { header: { 'x-pipeline': JSON.stringify(pipeline) } },
      })
      if (error) throw new Error(`Engine /check failed: ${JSON.stringify(error)}`)
      return data as { source: CheckResult; destination: CheckResult }
    },

    async source_discover(source: PipelineConfig['source']): Promise<CatalogMessage> {
      // Only source config is needed for discover — pass a minimal pipeline header
      const ph = JSON.stringify({ source, destination: { type: '_' } })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (client.POST as any)('/discover', {
        params: { header: { 'x-pipeline': ph } },
      })
      if (error) throw new Error(`Engine /discover failed: ${JSON.stringify(error)}`)
      return data as CatalogMessage
    },

    async *pipeline_read(
      pipeline: PipelineConfig,
      opts?: SyncOpts,
      input?: AsyncIterable<unknown>
    ): AsyncIterable<Message> {
      const body = input ? toNdjsonStream(input) : undefined
      const res = await post('/read', pipeline, opts, body)
      yield* parseNdjsonStream<Message>(res.body!)
    },

    async *pipeline_write(
      pipeline: PipelineConfig,
      messages: AsyncIterable<Message>
    ): AsyncIterable<DestinationOutput> {
      const res = await post('/write', pipeline, undefined, toNdjsonStream(messages))
      yield* parseNdjsonStream<DestinationOutput>(res.body!)
    },

    async *pipeline_sync(
      pipeline: PipelineConfig,
      opts?: SyncOpts,
      input?: AsyncIterable<unknown>
    ): AsyncIterable<DestinationOutput> {
      const body = input ? toNdjsonStream(input) : undefined
      const res = await post('/sync', pipeline, opts, body)
      yield* parseNdjsonStream<DestinationOutput>(res.body!)
    },
  }
}
