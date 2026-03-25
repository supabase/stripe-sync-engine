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
} from '@stripe/sync-protocol'
import type { Destination, Source } from '@stripe/sync-protocol'
import { enforceCatalog, filterType, log, persistState, pipe } from './pipeline.js'
import type { StateStore } from './state-store.js'
import type { ConnectorResolver } from './resolver.js'

// MARK: - Engine interface

export interface Engine {
  setup(): Promise<void>
  teardown(opts?: { remove_shared_resources?: boolean }): Promise<void>
  check(): Promise<{ source: CheckResult; destination: CheckResult }>
  read(input?: AsyncIterable<unknown>): AsyncIterable<Message>
  write(messages: AsyncIterable<Message>): AsyncIterable<DestinationOutput>
  sync(input?: AsyncIterable<unknown>): AsyncIterable<DestinationOutput>
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
        fields: wanted.get(s.name)!.fields,
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
  stateStore: StateStore
): Engine {
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

  return {
    async setup() {
      const catalog = await getCatalog()
      await Promise.all([
        connectors.source.setup?.({ config: sourceConfig, catalog }),
        connectors.destination.setup?.({ config: destConfig, catalog }),
      ])
    },

    async teardown(teardownOpts?: { remove_shared_resources?: boolean }) {
      await Promise.all([
        connectors.source.teardown?.({ config: sourceConfig, ...teardownOpts }),
        connectors.destination.teardown?.({ config: destConfig, ...teardownOpts }),
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
      const stored = await stateStore.get()
      const state = stored ?? config.state
      const raw = connectors.source.read(
        { config: sourceConfig, catalog: await getCatalog(), state },
        input
      )
      for await (const msg of raw) {
        yield Message.parse(msg)
      }
    },

    async *write(messages: AsyncIterable<Message>) {
      const catalog = await getCatalog()
      const destInput = pipe(messages, enforceCatalog(catalog), log, filterType('record', 'state'))
      const destOutput = connectors.destination.write({ config: destConfig, catalog }, destInput)
      for await (const msg of destOutput) {
        yield DestinationOutput.parse(msg)
      }
    },

    async *sync(input?: AsyncIterable<unknown>) {
      await this.setup()
      yield* pipe(this.write(this.read(input)), persistState(stateStore))
    },
  }
}

export async function createEngineFromParams(
  params: SyncParams,
  resolver: ConnectorResolver,
  stateStore: StateStore
): Promise<Engine> {
  const { source_name: sourceName, destination_name: destName, ...engineParams } = params
  const [source, destination] = await Promise.all([
    resolver.resolveSource(sourceName),
    resolver.resolveDestination(destName),
  ])
  return createEngine(engineParams, { source, destination }, stateStore)
}
