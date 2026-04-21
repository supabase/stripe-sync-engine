import createClient from 'openapi-fetch'
import type { paths } from '../__generated__/openapi.js'
import type { Engine, SourceReadOptions, ConnectorInfo, ConnectorListItem } from './engine.js'
import { parseNdjsonStream, toNdjsonStream } from './ndjson.js'
import type {
  CheckOutput,
  SetupOutput,
  TeardownOutput,
  DestinationOutput,
  DiscoverOutput,
  Message,
  PipelineConfig,
  SyncOutput,
} from '@stripe/sync-protocol'
import { withAbortOnReturn } from '@stripe/sync-protocol'

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
 * Uses openapi-fetch for typed JSON endpoints (/meta/*).
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

  function stateHeaders(opts?: SourceReadOptions): Record<string, string> {
    const h: Record<string, string> = {}
    if (opts?.state) {
      h['x-state'] = JSON.stringify(opts.state)
    }
    return h
  }

  function queryParams(opts?: SourceReadOptions & { only?: string }): Record<string, string> {
    const q: Record<string, string> = {}
    if (opts?.time_limit != null) q.time_limit = String(opts.time_limit)
    if (opts?.run_id != null) q.run_id = opts.run_id
    if (opts?.only != null) q.only = opts.only
    return q
  }

  /** Convert `{ only }` opts into the shape `post()` expects for query params. */
  function onlyToReadOpts(
    opts?: { only?: 'source' | 'destination' }
  ): SourceReadOptions & { only?: string } {
    return opts?.only ? { only: opts.only } : {}
  }

  async function post(
    path:
      | '/pipeline_check'
      | '/pipeline_read'
      | '/pipeline_write'
      | '/pipeline_sync'
      | '/pipeline_setup'
      | '/pipeline_teardown',
    pipeline: PipelineConfig,
    opts?: SourceReadOptions & { only?: string },
    body?: ReadableStream<Uint8Array>,
    signal?: AbortSignal
  ): Promise<Response> {
    const ph = JSON.stringify(pipeline)
    const headers = { ...stateHeaders(opts) }
    const { response } = await streamPost(path, {
      params: { header: { 'x-pipeline': ph }, query: queryParams(opts) },
      parseAs: 'stream',
      headers,
      signal,
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
    async meta_sources_list(): Promise<{ items: ConnectorListItem[] }> {
      const { data, error } = await client.GET('/meta/sources')
      if (error) throw new Error(`Engine /meta/sources failed: ${JSON.stringify(error)}`)
      return data
    },

    async meta_sources_get(type: string): Promise<ConnectorInfo> {
      const { data, error } = await client.GET('/meta/sources/{type}', {
        params: { path: { type } },
      })
      if (error) throw new Error(`Engine /meta/sources/${type} failed: ${JSON.stringify(error)}`)
      return data!
    },

    async meta_destinations_list(): Promise<{ items: ConnectorListItem[] }> {
      const { data, error } = await client.GET('/meta/destinations')
      if (error) throw new Error(`Engine /meta/destinations failed: ${JSON.stringify(error)}`)
      return data
    },

    async meta_destinations_get(type: string): Promise<ConnectorInfo> {
      const { data, error } = await client.GET('/meta/destinations/{type}', {
        params: { path: { type } },
      })
      if (error)
        throw new Error(`Engine /meta/destinations/${type} failed: ${JSON.stringify(error)}`)
      return data!
    },

    async *source_discover(source: PipelineConfig['source']): AsyncIterable<DiscoverOutput> {
      const { response } = await streamPost('/source_discover', {
        params: { header: { 'x-source': JSON.stringify(source) } },
      })
      if (!response.ok) throw new Error(`source_discover failed: ${response.status}`)
      yield* parseNdjsonStream<DiscoverOutput>(response.body!)
    },

    async *pipeline_check(
      pipeline: PipelineConfig,
      opts?: { only?: 'source' | 'destination' }
    ): AsyncIterable<CheckOutput> {
      const res = await post('/pipeline_check', pipeline, onlyToReadOpts(opts))
      yield* parseNdjsonStream<CheckOutput>(res.body!)
    },

    async *pipeline_setup(
      pipeline: PipelineConfig,
      opts?: { only?: 'source' | 'destination' }
    ): AsyncIterable<SetupOutput> {
      const res = await post('/pipeline_setup', pipeline, onlyToReadOpts(opts))
      yield* parseNdjsonStream<SetupOutput>(res.body!)
    },

    async *pipeline_teardown(
      pipeline: PipelineConfig,
      opts?: { only?: 'source' | 'destination' }
    ): AsyncIterable<TeardownOutput> {
      const res = await post('/pipeline_teardown', pipeline, onlyToReadOpts(opts))
      yield* parseNdjsonStream<TeardownOutput>(res.body!)
    },

    pipeline_read(
      pipeline: PipelineConfig,
      opts?: SourceReadOptions,
      input?: AsyncIterable<unknown>
    ): AsyncIterable<Message> {
      return withAbortOnReturn((signal) =>
        (async function* () {
          const body = input ? toNdjsonStream(input) : undefined
          const res = await post('/pipeline_read', pipeline, opts, body, signal)
          yield* parseNdjsonStream<Message>(res.body!)
        })()
      )
    },

    pipeline_write(
      pipeline: PipelineConfig,
      messages: AsyncIterable<Message>
    ): AsyncIterable<DestinationOutput> {
      return withAbortOnReturn((signal) =>
        (async function* () {
          const res = await post(
            '/pipeline_write',
            pipeline,
            undefined,
            toNdjsonStream(messages),
            signal
          )
          yield* parseNdjsonStream<DestinationOutput>(res.body!)
        })()
      )
    },

    pipeline_sync(
      pipeline: PipelineConfig,
      opts?: SourceReadOptions,
      input?: AsyncIterable<unknown>
    ): AsyncIterable<SyncOutput> {
      return withAbortOnReturn((signal) =>
        (async function* () {
          const body = input ? toNdjsonStream(input) : undefined
          const res = await post('/pipeline_sync', pipeline, opts, body, signal)
          yield* parseNdjsonStream<SyncOutput>(res.body!)
        })()
      )
    },
  }
}
