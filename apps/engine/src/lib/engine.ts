import { z } from 'zod'
import {
  DestinationOutput,
  Message,
  PipelineConfig,
  Stream,
  ConfiguredStream,
  ConfiguredCatalog,
  CheckResult,
} from '@stripe/sync-protocol'
import type { Destination, Source } from '@stripe/sync-protocol'
import { enforceCatalog, filterType, log, persistState, pipe } from './pipeline.js'
import { applySelection } from './destination-filter.js'
import type { StateStore } from './state-store.js'
import type { ConnectorResolver } from './resolver.js'
import { logger } from '../logger.js'

// MARK: - Engine interface

export interface SetupResult {
  source?: Record<string, unknown>
  destination?: Record<string, unknown>
}

export interface Engine {
  setup(): Promise<SetupResult>
  teardown(): Promise<void>
  check(): Promise<{ source: CheckResult; destination: CheckResult }>
  read(input?: AsyncIterable<unknown>): AsyncIterable<Message>
  write(messages: AsyncIterable<Message>): AsyncIterable<DestinationOutput>
  sync(input?: AsyncIterable<unknown>): AsyncIterable<DestinationOutput>
}

function engineLogContext(config: PipelineConfig): Record<string, unknown> {
  return {
    sourceName: config.source.type,
    destinationName: config.destination.type,
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
  configStreams?: PipelineConfig['streams']
): ConfiguredCatalog {
  let streams: ConfiguredStream[]

  if (configStreams && configStreams.length > 0) {
    const wanted = new Map(configStreams.map((s) => [s.name, s]))
    streams = discovered
      .filter((s) => wanted.has(s.name))
      .map((s) => {
        const cfg = wanted.get(s.name)!
        return {
          stream: s,
          sync_mode: cfg.sync_mode ?? 'full_refresh',
          destination_sync_mode: 'append' as const,
          fields: cfg.fields,
          backfill_limit: cfg.backfill_limit,
        }
      })
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
  config: PipelineConfig,
  connectors: { source: Source; destination: Destination },
  stateStore: StateStore
): Engine {
  // Validate configs using connector JSON Schemas (fail-fast)
  const sourceSpec = connectors.source.spec()
  const destSpec = connectors.destination.spec()
  const { type: _sn, ...rawSourceConfig } = config.source
  const { type: _dn, ...rawDestConfig } = config.destination
  const sourceConfig = z.fromJSONSchema(sourceSpec.config).parse(rawSourceConfig) as Record<
    string,
    unknown
  >
  const destConfig = z.fromJSONSchema(destSpec.config).parse(rawDestConfig) as Record<
    string,
    unknown
  >
  const baseContext = engineLogContext(config)

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
      const filteredCatalog = applySelection(catalog)
      const [sourceUpdates, destUpdates] = await Promise.all([
        connectors.source.setup
          ? withLoggedStep('Engine source setup', baseContext, () =>
              connectors.source.setup!({ config: sourceConfig, catalog })
            )
          : Promise.resolve(undefined),
        connectors.destination.setup
          ? withLoggedStep('Engine destination setup', baseContext, () =>
              connectors.destination.setup!({ config: destConfig, catalog: filteredCatalog })
            )
          : Promise.resolve(undefined),
      ])
      const result: SetupResult = {}
      if (sourceUpdates) {
        Object.assign(sourceConfig, sourceUpdates)
        result.source = sourceUpdates
      }
      if (destUpdates) {
        Object.assign(destConfig, destUpdates)
        result.destination = destUpdates
      }
      return result
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
      const state = await stateStore.get()
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
      const filteredCatalog = applySelection(catalog)
      const destInput = pipe(
        messages,
        enforceCatalog(filteredCatalog),
        log,
        filterType('record', 'state')
      )
      const destOutput = connectors.destination.write(
        { config: destConfig, catalog: filteredCatalog },
        destInput
      )
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
      yield* pipe(this.read(input), this.write, persistState(stateStore))
    },
  }
}

export async function createEngineFromParams(
  params: PipelineConfig,
  resolver: ConnectorResolver,
  stateStore: StateStore
): Promise<Engine> {
  const [source, destination] = await Promise.all([
    resolver.resolveSource(params.source.type),
    resolver.resolveDestination(params.destination.type),
  ])
  return createEngine(params, { source, destination }, stateStore)
}
