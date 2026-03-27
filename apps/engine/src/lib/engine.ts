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
import { logger } from '../logger.js'

// MARK: - Engine interface

export interface Engine {
  setup(): Promise<void>
  teardown(): Promise<void>
  check(): Promise<{ source: CheckResult; destination: CheckResult }>
  read(input?: AsyncIterable<unknown>): AsyncIterable<Message>
  write(messages: AsyncIterable<Message>): AsyncIterable<DestinationOutput>
  sync(input?: AsyncIterable<unknown>): AsyncIterable<DestinationOutput>
}

type EngineLogMetadata = {
  sourceName?: string
  destinationName?: string
}

function engineLogContext(
  config: SyncEngineParams,
  metadata?: EngineLogMetadata
): Record<string, unknown> {
  return {
    sourceName: metadata?.sourceName ?? 'unknown',
    destinationName: metadata?.destinationName ?? 'unknown',
    configuredStreamCount: config.streams?.length ?? 0,
    configuredStreams: config.streams?.map((stream) => stream.name) ?? [],
  }
}

async function withLoggedStep<T>(
  label: string,
  context: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now()
  logger.info(context, `${label} started`)
  try {
    const result = await fn()
    logger.info({ ...context, durationMs: Date.now() - startedAt }, `${label} completed`)
    return result
  } catch (error) {
    logger.error({ ...context, durationMs: Date.now() - startedAt, err: error }, `${label} failed`)
    throw error
  }
}

async function* withLoggedStream<T>(
  label: string,
  context: Record<string, unknown>,
  iter: AsyncIterable<T>
): AsyncIterable<T> {
  const startedAt = Date.now()
  let itemCount = 0
  logger.info(context, `${label} started`)
  try {
    for await (const item of iter) {
      itemCount++
      yield item
    }
    logger.info({ ...context, itemCount, durationMs: Date.now() - startedAt }, `${label} completed`)
  } catch (error) {
    logger.error(
      { ...context, itemCount, durationMs: Date.now() - startedAt, err: error },
      `${label} failed`
    )
    throw error
  }
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
  stateStore: StateStore,
  metadata?: EngineLogMetadata
): Engine {
  // Validate configs using connector JSON Schemas (fail-fast)
  const sourceSpec = connectors.source.spec()
  const destSpec = connectors.destination.spec()
  const { name: _sn, ...rawSourceConfig } = config.source
  const { name: _dn, ...rawDestConfig } = config.destination
  const sourceConfig = z.fromJSONSchema(sourceSpec.config).parse(rawSourceConfig) as Record<
    string,
    unknown
  >
  const destConfig = z.fromJSONSchema(destSpec.config).parse(rawDestConfig) as Record<
    string,
    unknown
  >
  const baseContext = engineLogContext(config, metadata)

  // Lazy-cached catalog — discover is called at most once per engine instance.
  let _catalog: ConfiguredCatalog | null = null
  async function getCatalog(): Promise<ConfiguredCatalog> {
    if (!_catalog) {
      const startedAt = Date.now()
      logger.info(baseContext, 'Engine source discover started')
      try {
        const msg = await connectors.source.discover({ config: sourceConfig })
        _catalog = buildCatalog(msg.streams, config.streams)
        logger.info(
          {
            ...baseContext,
            durationMs: Date.now() - startedAt,
            discoveredStreamCount: msg.streams.length,
            catalogStreamCount: _catalog.streams.length,
            catalogStreams: _catalog.streams.map((stream) => stream.stream.name),
          },
          'Engine source discover completed'
        )
      } catch (error) {
        logger.error(
          { ...baseContext, durationMs: Date.now() - startedAt, err: error },
          'Engine source discover failed'
        )
        throw error
      }
    }
    return _catalog
  }

  return {
    async setup() {
      const catalog = await getCatalog()
      await Promise.all([
        connectors.source.setup
          ? withLoggedStep('Engine source setup', baseContext, () =>
              connectors.source.setup!({ config: sourceConfig, catalog })
            )
          : Promise.resolve(),
        connectors.destination.setup
          ? withLoggedStep('Engine destination setup', baseContext, () =>
              connectors.destination.setup!({ config: destConfig, catalog })
            )
          : Promise.resolve(),
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
      const stored = await stateStore.get()
      const state = stored ?? config.state
      const raw = connectors.source.read(
        { config: sourceConfig, catalog: await getCatalog(), state },
        input
      )
      for await (const msg of withLoggedStream(
        'Engine source read',
        {
          ...baseContext,
          inputProvided: input !== undefined,
          stateProvided: state !== undefined,
        },
        raw
      )) {
        yield Message.parse(msg)
      }
    },

    async *write(messages: AsyncIterable<Message>) {
      const catalog = await getCatalog()
      const destInput = pipe(messages, enforceCatalog(catalog), log, filterType('record', 'state'))
      const destOutput = connectors.destination.write({ config: destConfig, catalog }, destInput)
      for await (const msg of withLoggedStream(
        'Engine destination write',
        baseContext,
        destOutput
      )) {
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
  const sourceName = params.source.name
  const destName = params.destination.name
  const [source, destination] = await Promise.all([
    resolver.resolveSource(sourceName),
    resolver.resolveDestination(destName),
  ])
  return createEngine(params, { source, destination }, stateStore, {
    sourceName,
    destinationName: destName,
  })
}
