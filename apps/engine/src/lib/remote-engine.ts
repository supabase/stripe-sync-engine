import createClient from 'openapi-fetch'
import type { paths } from '../__generated__/openapi.js'
import type {
  Engine,
  SourceReadOptions,
  BatchSyncOptions,
  ConnectorInfo,
  ConnectorListItem,
} from './engine.js'
import { parseNdjsonStream } from './ndjson.js'
import type {
  CheckOutput,
  SetupOutput,
  TeardownOutput,
  DestinationOutput,
  DiscoverOutput,
  EofPayload,
  Message,
  PipelineConfig,
  SyncOutput,
} from '@stripe/sync-protocol'
import { withAbortOnReturn } from '@stripe/sync-protocol'

// openapi-typescript does not model NDJSON streaming responses correctly.
// We use targeted casts on the POST calls for streaming endpoints.
type StreamPost = (path: string, init: Record<string, unknown>) => Promise<{ response: Response }>

/**
 * HTTP client that satisfies the Engine interface by delegating each method to
 * the corresponding sync engine REST endpoint.
 *
 * Uses openapi-fetch for typed JSON endpoints (/meta/*).
 * Streaming NDJSON endpoints use `client.POST` with targeted casts.
 *
 * All endpoints accept a JSON request body containing pipeline config, state,
 * and any endpoint-specific options. Responses are NDJSON streams.
 *
 * Usage:
 *   const engine = createRemoteEngine('http://localhost:3001')
 *   await engine.pipeline_setup(pipeline)
 *   for await (const msg of engine.pipeline_sync(pipeline)) { ... }
 */
export function createRemoteEngine(engineUrl: string): Engine {
  const client = createClient<paths>({ baseUrl: engineUrl })

  // Cast once: streaming endpoints need untyped POST due to generator limitations
  const streamPost = client.POST as unknown as StreamPost

  async function post(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Response> {
    const { response } = await streamPost(path, {
      body,
      parseAs: 'stream',
      signal,
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
      const res = await post('/source_discover', { source })
      yield* parseNdjsonStream<DiscoverOutput>(res.body!)
    },

    async *pipeline_check(
      pipeline: PipelineConfig,
      opts?: { only?: 'source' | 'destination' }
    ): AsyncIterable<CheckOutput> {
      const res = await post('/pipeline_check', { pipeline, only: opts?.only })
      yield* parseNdjsonStream<CheckOutput>(res.body!)
    },

    async *pipeline_setup(
      pipeline: PipelineConfig,
      opts?: { only?: 'source' | 'destination' }
    ): AsyncIterable<SetupOutput> {
      const res = await post('/pipeline_setup', { pipeline, only: opts?.only })
      yield* parseNdjsonStream<SetupOutput>(res.body!)
    },

    async *pipeline_teardown(
      pipeline: PipelineConfig,
      opts?: { only?: 'source' | 'destination' }
    ): AsyncIterable<TeardownOutput> {
      const res = await post('/pipeline_teardown', { pipeline, only: opts?.only })
      yield* parseNdjsonStream<TeardownOutput>(res.body!)
    },

    pipeline_read(
      pipeline: PipelineConfig,
      opts?: SourceReadOptions,
      input?: AsyncIterable<unknown>
    ): AsyncIterable<Message> {
      return withAbortOnReturn((signal) =>
        (async function* () {
          let stdin: unknown[] | undefined
          if (input) {
            stdin = []
            for await (const m of input) stdin.push(m)
          }
          const res = await post(
            '/pipeline_read',
            {
              pipeline,
              state: opts?.state,
              time_limit: opts?.time_limit,
              stdin,
            },
            signal
          )
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
          // Collect messages into array for JSON body
          const msgs: Message[] = []
          for await (const m of messages) msgs.push(m)
          const res = await post('/pipeline_write', { pipeline, stdin: msgs }, signal)
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
          let stdin: unknown[] | undefined
          if (input) {
            stdin = []
            for await (const m of input) stdin.push(m)
          }
          const res = await post(
            '/pipeline_sync',
            {
              pipeline,
              state: opts?.state,
              time_limit: opts?.time_limit,
              soft_time_limit: opts?.soft_time_limit,
              run_id: opts?.run_id,
              stdin,
            },
            signal
          )
          yield* parseNdjsonStream<SyncOutput>(res.body!)
        })()
      )
    },

    async pipeline_sync_batch(
      pipeline: PipelineConfig,
      opts?: BatchSyncOptions
    ): Promise<EofPayload> {
      const res = await post('/pipeline_sync_batch', {
        pipeline,
        state: opts?.state,
        run_id: opts?.run_id,
        state_limit: opts?.state_limit,
      })
      return (await res.json()) as EofPayload
    },
  }
}
