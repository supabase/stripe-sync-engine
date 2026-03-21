import { z } from 'zod'
import {
  DestinationOutput,
  Message,
  SyncEngineParams,
  SyncParams,
  Stream,
  ConfiguredStream,
  ConfiguredCatalog,
  CheckResult,
  StateMessage,
} from '@stripe/protocol'
import type { Destination, Source } from '@stripe/protocol'
import type { RouterCallbacks } from './pipeline'
import { forward, collect } from './pipeline'
import type { ConnectorResolver } from './loader'

// MARK: - Engine interface

export interface Engine {
  setup(): Promise<void>
  teardown(): Promise<void>
  check(): Promise<{ source: CheckResult; destination: CheckResult }>
  read(input?: AsyncIterable<unknown>): AsyncIterable<Message>
  write(messages: AsyncIterable<Message>): AsyncIterable<StateMessage>
  run(input?: AsyncIterable<unknown>): AsyncIterable<StateMessage>
}

// MARK: - Helpers

const stderrCallbacks: RouterCallbacks = {
  onLog: (message: string, level: string) => console.error(`[${level}] ${message}`),
  onError: (message: string, failureType: string) =>
    console.error(`[error:${failureType}] ${message}`),
  onStreamStatus: (stream: string, status: string) =>
    console.error(`[status] ${stream}: ${status}`),
}

/**
 * Build a ConfiguredCatalog from discovered streams, optionally filtered
 * by the streams listed in config.
 */
export function buildCatalog(
  discovered: Stream[],
  configStreams?: SyncEngineParams['streams']
): ConfiguredCatalog {
  let streams: ConfiguredStream[]

  if (configStreams && configStreams.length > 0) {
    const wanted = new Map(configStreams.map((s) => [s.name, s]))
    streams = discovered
      .filter((s) => wanted.has(s.name))
      .map((s) => ({
        stream: s,
        sync_mode: wanted.get(s.name)!.sync_mode ?? 'full_refresh',
        destination_sync_mode: 'append' as const,
      }))
  } else {
    streams = discovered.map((s) => ({
      stream: s,
      sync_mode: 'full_refresh' as const,
      destination_sync_mode: 'append' as const,
    }))
  }

  return { streams }
}

// MARK: - Factory

export function createEngine(
  config: SyncEngineParams,
  connectors: { source: Source; destination: Destination },
  callbacks?: RouterCallbacks
): Engine {
  const cb = callbacks ?? stderrCallbacks

  // Validate configs using connector JSON Schemas (fail-fast)
  const sourceSpec = connectors.source.spec()
  const destSpec = connectors.destination.spec()
  const sourceConfig = z.fromJSONSchema(sourceSpec.config).parse(config.source_config) as Record<
    string,
    unknown
  >
  const destConfig = z.fromJSONSchema(destSpec.config).parse(config.destination_config) as Record<
    string,
    unknown
  >

  // Lazy-cached catalog — discover is called at most once per engine instance.
  let _catalog: ConfiguredCatalog | null = null
  async function getCatalog(): Promise<ConfiguredCatalog> {
    if (!_catalog) {
      const msg = await connectors.source.discover({ config: sourceConfig })
      _catalog = buildCatalog(msg.streams, config.streams)
    }
    return _catalog
  }

  /** Set of stream names in the catalog, for membership validation. */
  function catalogStreamNames(catalog: ConfiguredCatalog): Set<string> {
    return new Set(catalog.streams.map((s) => s.stream.name))
  }

  return {
    async setup() {
      const catalog = await getCatalog()
      await Promise.all([
        connectors.source.setup?.({ config: sourceConfig, catalog }),
        connectors.destination.setup?.({ config: destConfig, catalog }),
      ])
    },

    async teardown() {
      await Promise.all([
        connectors.source.teardown?.({ config: sourceConfig }),
        connectors.destination.teardown?.({ config: destConfig }),
      ])
    },

    async check() {
      const [source, destination] = await Promise.all([
        connectors.source.check({ config: sourceConfig }),
        connectors.destination.check({ config: destConfig }),
      ])
      return { source, destination }
    },

    async *read(input?: AsyncIterable<unknown>) {
      const catalog = await getCatalog()
      const knownStreams = catalogStreamNames(catalog)

      const raw = connectors.source.read(
        { config: sourceConfig, catalog, state: config.state },
        input
      )

      for await (const msg of raw) {
        const validated = Message.parse(msg)
        // Stream membership check for record and state messages
        if (
          (validated.type === 'record' || validated.type === 'state') &&
          !knownStreams.has(validated.stream)
        ) {
          cb.onError?.(`Unknown stream "${validated.stream}" not in catalog`, 'system_error')
          continue
        }
        yield validated
      }
    },

    async *write(messages: AsyncIterable<Message>) {
      const catalog = await getCatalog()
      const forwarded = forward(messages, cb)
      const destOutput = connectors.destination.write({ config: destConfig, catalog }, forwarded)
      for await (const msg of destOutput) {
        yield* collect(
          (async function* () {
            yield DestinationOutput.parse(msg)
          })(),
          cb
        )
      }
    },

    async *run(input?: AsyncIterable<unknown>) {
      await this.setup()
      yield* this.write(this.read(input))
    },
  }
}

export async function createEngineFromParams(
  params: SyncParams,
  resolver: ConnectorResolver,
  callbacks?: RouterCallbacks
): Promise<Engine> {
  const { source_name: sourceName, destination_name: destName, ...engineParams } = params
  const [source, destination] = await Promise.all([
    resolver.resolveSource(sourceName),
    resolver.resolveDestination(destName),
  ])
  return createEngine(engineParams, { source, destination }, callbacks)
}
