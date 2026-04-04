import { z } from 'zod'
import {
  DestinationOutput,
  DiscoverOutput,
  Message,
  PipelineConfig,
  Stream,
  ConfiguredStream,
  ConfiguredCatalog,
  ConnectionStatusPayload,
  collectSpec,
  collectConnectionStatus,
  collectCatalog,
  collectControls,
  drainStream,
} from '@stripe/sync-protocol'

import { enforceCatalog, filterType, log, pipe, takeLimits } from './pipeline.js'
import { applySelection } from './destination-filter.js'
import type { ConnectorResolver } from './resolver.js'
import { logger } from '../logger.js'

// MARK: - Engine interface

/** Config updates returned by a connector's `setup()` call that should be merged back into the pipeline config. */
export const SetupResult = z.object({
  source: z.record(z.string(), z.unknown()).optional(),
  destination: z.record(z.string(), z.unknown()).optional(),
})
export type SetupResult = z.infer<typeof SetupResult>

export const SourceReadOptions = z.object({
  /** Per-stream state cursors carried in from the previous sync run. */
  state: z.record(z.string(), z.unknown()).optional(),
  /** Stop after emitting this many state messages (useful for paging). */
  stateLimit: z.number().int().positive().optional(),
  /** Wall-clock time limit in seconds; the stream stops after this duration. */
  timeLimit: z.number().positive().optional(),
})
export type SourceReadOptions = z.infer<typeof SourceReadOptions>

/** Metadata for a single connector type, including its configuration JSON Schema. */
export const ConnectorInfo = z.object({
  config_schema: z.record(z.string(), z.unknown()),
})
export type ConnectorInfo = z.infer<typeof ConnectorInfo>

/** {@link ConnectorInfo} plus the connector's `type` identifier, as returned by the list endpoints. */
export const ConnectorListItem = ConnectorInfo.extend({ type: z.string() })
export type ConnectorListItem = z.infer<typeof ConnectorListItem>

/**
 * The core sync engine abstraction.
 *
 * Implementations include:
 * - `createEngine()` — in-process, backed by connector instances directly
 * - `createRemoteEngine()` — HTTP client that forwards calls to an engine HTTP API
 */
export interface Engine {
  /** List all registered source connector types with their config schemas. */
  meta_sources_list(): Promise<{ data: ConnectorListItem[] }>
  /** Fetch metadata (config schema) for a single source connector type. */
  meta_source(type: string): Promise<ConnectorInfo>
  /** List all registered destination connector types with their config schemas. */
  meta_destinations_list(): Promise<{ data: ConnectorListItem[] }>
  /** Fetch metadata (config schema) for a single destination connector type. */
  meta_destination(type: string): Promise<ConnectorInfo>

  /**
   * Run connector `setup()` hooks for both source and destination.
   * Returns any config updates the connectors want written back to the pipeline record.
   */
  pipeline_setup(pipeline: PipelineConfig): Promise<SetupResult>
  /** Run connector `teardown()` hooks for both source and destination. */
  pipeline_teardown(pipeline: PipelineConfig): Promise<void>
  /** Run connector `check()` for both source and destination and return their statuses. */
  pipeline_check(
    pipeline: PipelineConfig
  ): Promise<{ source: ConnectionStatusPayload; destination: ConnectionStatusPayload }>

  /**
   * Discover the streams available from a source.
   * Yields a stream of {@link DiscoverOutput} messages (catalog, log, trace).
   * Use `collectCatalog()` from `@stripe/sync-protocol` to consume the result.
   */
  source_discover(source: PipelineConfig['source']): AsyncIterable<DiscoverOutput>

  /**
   * Read records from the source.
   * Yields raw {@link Message} objects (records, states, logs).
   * Optionally accepts previously persisted state and an upstream input iterable.
   */
  pipeline_read(
    pipeline: PipelineConfig,
    opts?: SourceReadOptions,
    input?: AsyncIterable<unknown>
  ): AsyncIterable<Message>

  /**
   * Write a stream of messages to the destination.
   * Filters for record and state messages, enforces the configured catalog,
   * and yields {@link DestinationOutput} messages (states, logs) from the destination.
   */
  pipeline_write(
    pipeline: PipelineConfig,
    messages: AsyncIterable<Message>
  ): AsyncIterable<DestinationOutput>

  /**
   * Full sync: setup → read → write, wired as a single streaming pipeline.
   * Yields {@link DestinationOutput} messages; state messages should be persisted
   * by the caller for resumability.
   */
  pipeline_sync(
    pipeline: PipelineConfig,
    opts?: SourceReadOptions,
    input?: AsyncIterable<unknown>
  ): AsyncIterable<DestinationOutput>
}

function engineLogContext(pipeline: PipelineConfig): Record<string, unknown> {
  return {
    sourceName: pipeline.source.type,
    destinationName: pipeline.destination.type,
    configuredStreamCount: pipeline.streams?.length ?? 0,
    configuredStreams: pipeline.streams?.map((stream) => stream.name) ?? [],
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
 * Build a {@link ConfiguredCatalog} from the streams discovered by the source.
 *
 * If `configStreams` is provided, only the listed stream names are included
 * and their `sync_mode`/`fields`/`backfill_limit` overrides are applied.
 * If omitted, all discovered streams are included with `full_refresh` mode.
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

/** Helper to get spec config from a connector (spec() is now async iterable). */
async function getSpecConfig(
  connector: { spec(): AsyncIterable<Message> },
  rawConfig: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { spec: specPayload } = await collectSpec(connector.spec())
  return z.fromJSONSchema(specPayload.config).parse(rawConfig) as Record<string, unknown>
}

// MARK: - Factory

/**
 * Create an in-process {@link Engine} backed by the given connector resolver.
 *
 * @param resolver - Resolves connector type names to connector instances.
 */
export async function createEngine(resolver: ConnectorResolver): Promise<Engine> {
  const engine: Engine = {
    async meta_sources_list() {
      return {
        data: [...resolver.sources()].map(([type, r]) => ({
          type,
          config_schema: r.rawConfigJsonSchema,
        })),
      }
    },

    async meta_source(type: string): Promise<ConnectorInfo> {
      const r = resolver.sources().get(type)
      if (!r) throw new Error(`Unknown source connector: ${type}`)
      return { config_schema: r.rawConfigJsonSchema }
    },

    async meta_destinations_list() {
      return {
        data: [...resolver.destinations()].map(([type, r]) => ({
          type,
          config_schema: r.rawConfigJsonSchema,
        })),
      }
    },

    async meta_destination(type: string): Promise<ConnectorInfo> {
      const r = resolver.destinations().get(type)
      if (!r) throw new Error(`Unknown destination connector: ${type}`)
      return { config_schema: r.rawConfigJsonSchema }
    },

    async *source_discover(sourceInput: PipelineConfig['source']): AsyncIterable<DiscoverOutput> {
      const connector = await resolver.resolveSource(sourceInput.type)
      const { type: _, ...rawSrc } = sourceInput
      const sourceConfig = await getSpecConfig(connector, rawSrc)
      yield* connector.discover({ config: sourceConfig })
    },

    async pipeline_setup(pipeline: PipelineConfig): Promise<SetupResult> {
      const baseContext = engineLogContext(pipeline)
      const [srcConnector, destConnector] = await Promise.all([
        resolver.resolveSource(pipeline.source.type),
        resolver.resolveDestination(pipeline.destination.type),
      ])
      const { type: _s, ...rawSrc } = pipeline.source
      const { type: _d, ...rawDest } = pipeline.destination
      const [sourceConfig, destConfig] = await Promise.all([
        getSpecConfig(srcConnector, rawSrc),
        getSpecConfig(destConnector, rawDest),
      ])

      const { catalog: catalogPayload } = await collectCatalog(
        engine.source_discover(pipeline.source)
      )
      const catalog = buildCatalog(catalogPayload.streams, pipeline.streams)
      const filteredCatalog = applySelection(catalog)

      const [sourceUpdates, destUpdates] = await Promise.all([
        srcConnector.setup
          ? withLoggedStep('Engine source setup', baseContext, async () => {
              const { configs } = await collectControls(
                srcConnector.setup!({ config: sourceConfig, catalog }) as AsyncIterable<Message>
              )
              return configs.length > 0
                ? configs.reduce((acc, c) => ({ ...acc, ...c }), {})
                : undefined
            })
          : Promise.resolve(undefined),
        destConnector.setup
          ? withLoggedStep('Engine destination setup', baseContext, async () => {
              const { configs } = await collectControls(
                destConnector.setup!({
                  config: destConfig,
                  catalog: filteredCatalog,
                }) as AsyncIterable<Message>
              )
              return configs.length > 0
                ? configs.reduce((acc, c) => ({ ...acc, ...c }), {})
                : undefined
            })
          : Promise.resolve(undefined),
      ])

      const result: SetupResult = {}
      if (sourceUpdates) result.source = sourceUpdates
      if (destUpdates) result.destination = destUpdates
      return result
    },

    async pipeline_teardown(pipeline: PipelineConfig): Promise<void> {
      const [srcConnector, destConnector] = await Promise.all([
        resolver.resolveSource(pipeline.source.type),
        resolver.resolveDestination(pipeline.destination.type),
      ])
      const { type: _s, ...rawSrc } = pipeline.source
      const { type: _d, ...rawDest } = pipeline.destination
      const [sourceConfig, destConfig] = await Promise.all([
        getSpecConfig(srcConnector, rawSrc),
        getSpecConfig(destConnector, rawDest),
      ])
      await Promise.all([
        srcConnector.teardown
          ? drainStream(srcConnector.teardown({ config: sourceConfig }) as AsyncIterable<Message>)
          : undefined,
        destConnector.teardown
          ? drainStream(destConnector.teardown({ config: destConfig }) as AsyncIterable<Message>)
          : undefined,
      ])
    },

    async pipeline_check(
      pipeline: PipelineConfig
    ): Promise<{ source: ConnectionStatusPayload; destination: ConnectionStatusPayload }> {
      const [srcConnector, destConnector] = await Promise.all([
        resolver.resolveSource(pipeline.source.type),
        resolver.resolveDestination(pipeline.destination.type),
      ])
      const { type: _s, ...rawSrc } = pipeline.source
      const { type: _d, ...rawDest } = pipeline.destination
      const [sourceConfig, destConfig] = await Promise.all([
        getSpecConfig(srcConnector, rawSrc),
        getSpecConfig(destConnector, rawDest),
      ])
      const [{ connection_status: source }, { connection_status: destination }] = await Promise.all(
        [
          collectConnectionStatus(
            srcConnector.check({ config: sourceConfig }) as AsyncIterable<Message>
          ),
          collectConnectionStatus(
            destConnector.check({ config: destConfig }) as AsyncIterable<Message>
          ),
        ]
      )
      return { source, destination }
    },

    async *pipeline_read(
      pipeline: PipelineConfig,
      opts?: SourceReadOptions,
      input?: AsyncIterable<unknown>
    ): AsyncIterable<Message> {
      const baseContext = engineLogContext(pipeline)
      const connector = await resolver.resolveSource(pipeline.source.type)
      const { type: _, ...rawSrc } = pipeline.source
      const sourceConfig = await getSpecConfig(connector, rawSrc)
      const { catalog: catalogPayload } = await collectCatalog(
        engine.source_discover(pipeline.source)
      )
      const catalog = buildCatalog(catalogPayload.streams, pipeline.streams)
      const state = opts?.state

      const raw = connector.read({ config: sourceConfig, catalog, state }, input)
      const logged = withLoggedStream(
        'Engine source read',
        {
          ...baseContext,
          inputProvided: input !== undefined,
          stateProvided: state !== undefined,
        },
        raw
      )
      const parsed: AsyncIterable<Message> = (async function* () {
        for await (const msg of logged) {
          yield Message.parse(msg)
        }
      })()
      yield* takeLimits<Message>({
        stateLimit: opts?.stateLimit,
        timeLimitMs: opts?.timeLimit ? opts.timeLimit * 1000 : undefined,
      })(parsed)
    },

    async *pipeline_write(
      pipeline: PipelineConfig,
      messages: AsyncIterable<Message>
    ): AsyncIterable<DestinationOutput> {
      const baseContext = engineLogContext(pipeline)
      const connector = await resolver.resolveDestination(pipeline.destination.type)
      const { type: _, ...rawDest } = pipeline.destination
      const destConfig = await getSpecConfig(connector, rawDest)
      const { catalog: catalogPayload } = await collectCatalog(
        engine.source_discover(pipeline.source)
      )
      const catalog = buildCatalog(catalogPayload.streams, pipeline.streams)
      const filteredCatalog = applySelection(catalog)

      const destInput = pipe(
        messages,
        enforceCatalog(filteredCatalog),
        log,
        filterType('record', 'state')
      )
      const destOutput = connector.write(
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

    async *pipeline_sync(
      pipeline: PipelineConfig,
      opts?: SourceReadOptions,
      input?: AsyncIterable<unknown>
    ): AsyncIterable<DestinationOutput> {
      await engine.pipeline_setup(pipeline)
      // Pass state to read() but not stateLimit — stateLimit on sync controls destination output
      const writeOutput = engine.pipeline_write(
        pipeline,
        engine.pipeline_read(pipeline, { state: opts?.state }, input)
      )
      yield* takeLimits<DestinationOutput>({
        stateLimit: opts?.stateLimit,
        timeLimitMs: opts?.timeLimit ? opts.timeLimit * 1000 : undefined,
      })(writeOutput)
    },
  }
  return engine
}
