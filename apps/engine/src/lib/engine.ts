import { z } from 'zod'
import {
  DestinationOutput,
  Message,
  PipelineConfig,
  Stream,
  ConfiguredStream,
  ConfiguredCatalog,
  CheckResult,
  CatalogMessage,
} from '@stripe/sync-protocol'
import { enforceCatalog, filterType, log, pipe, takeLimits } from './pipeline.js'
import { applySelection } from './destination-filter.js'
import type { ConnectorResolver } from './resolver.js'
import { logger } from '../logger.js'

// MARK: - Engine interface

export const SetupResult = z.object({
  source: z.record(z.string(), z.unknown()).optional(),
  destination: z.record(z.string(), z.unknown()).optional(),
})
export type SetupResult = z.infer<typeof SetupResult>

export const SyncOpts = z.object({
  state: z.record(z.string(), z.unknown()).optional(),
  stateLimit: z.number().int().positive().optional(),
  timeLimit: z.number().positive().optional(),
})
export type SyncOpts = z.infer<typeof SyncOpts>

export const ConnectorInfo = z.object({
  config_schema: z.record(z.string(), z.unknown()),
})
export type ConnectorInfo = z.infer<typeof ConnectorInfo>

export const ConnectorListItem = ConnectorInfo.extend({ type: z.string() })
export type ConnectorListItem = z.infer<typeof ConnectorListItem>

export interface Engine {
  meta_sources_list(): Promise<{ data: ConnectorListItem[] }>
  meta_source(type: string): Promise<ConnectorInfo>
  meta_destinations_list(): Promise<{ data: ConnectorListItem[] }>
  meta_destination(type: string): Promise<ConnectorInfo>
  pipeline_setup(pipeline: PipelineConfig): Promise<SetupResult>
  pipeline_teardown(pipeline: PipelineConfig): Promise<void>
  pipeline_check(
    pipeline: PipelineConfig
  ): Promise<{ source: CheckResult; destination: CheckResult }>
  source_discover(source: PipelineConfig['source']): Promise<CatalogMessage>
  pipeline_read(
    pipeline: PipelineConfig,
    opts?: SyncOpts,
    input?: AsyncIterable<unknown>
  ): AsyncIterable<Message>
  pipeline_write(
    pipeline: PipelineConfig,
    messages: AsyncIterable<Message>
  ): AsyncIterable<DestinationOutput>
  pipeline_sync(
    pipeline: PipelineConfig,
    opts?: SyncOpts,
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

export function createEngine(resolver: ConnectorResolver): Engine {
  return {
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

    async source_discover(sourceInput: PipelineConfig['source']): Promise<CatalogMessage> {
      const connector = await resolver.resolveSource(sourceInput.type)
      const { type: _, ...rawConfig } = sourceInput
      const config = z.fromJSONSchema(connector.spec().config).parse(rawConfig) as Record<
        string,
        unknown
      >
      return connector.discover({ config })
    },

    async pipeline_setup(pipeline: PipelineConfig): Promise<SetupResult> {
      const baseContext = engineLogContext(pipeline)
      const [srcConnector, destConnector] = await Promise.all([
        resolver.resolveSource(pipeline.source.type),
        resolver.resolveDestination(pipeline.destination.type),
      ])
      const { type: _s, ...rawSrc } = pipeline.source
      const { type: _d, ...rawDest } = pipeline.destination
      const sourceConfig = z.fromJSONSchema(srcConnector.spec().config).parse(rawSrc) as Record<
        string,
        unknown
      >
      const destConfig = z.fromJSONSchema(destConnector.spec().config).parse(rawDest) as Record<
        string,
        unknown
      >

      const catalogMsg = await this.source_discover(pipeline.source)
      const catalog = buildCatalog(catalogMsg.streams, pipeline.streams)
      const filteredCatalog = applySelection(catalog)

      const [sourceUpdates, destUpdates] = await Promise.all([
        srcConnector.setup
          ? withLoggedStep('Engine source setup', baseContext, () =>
              srcConnector.setup!({ config: sourceConfig, catalog })
            )
          : Promise.resolve(undefined),
        destConnector.setup
          ? withLoggedStep('Engine destination setup', baseContext, () =>
              destConnector.setup!({ config: destConfig, catalog: filteredCatalog })
            )
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
      const sourceConfig = z.fromJSONSchema(srcConnector.spec().config).parse(rawSrc) as Record<
        string,
        unknown
      >
      const destConfig = z.fromJSONSchema(destConnector.spec().config).parse(rawDest) as Record<
        string,
        unknown
      >
      await Promise.all([
        srcConnector.teardown?.({ config: sourceConfig }),
        destConnector.teardown?.({ config: destConfig }),
      ])
    },

    async pipeline_check(
      pipeline: PipelineConfig
    ): Promise<{ source: CheckResult; destination: CheckResult }> {
      const [srcConnector, destConnector] = await Promise.all([
        resolver.resolveSource(pipeline.source.type),
        resolver.resolveDestination(pipeline.destination.type),
      ])
      const { type: _s, ...rawSrc } = pipeline.source
      const { type: _d, ...rawDest } = pipeline.destination
      const sourceConfig = z.fromJSONSchema(srcConnector.spec().config).parse(rawSrc) as Record<
        string,
        unknown
      >
      const destConfig = z.fromJSONSchema(destConnector.spec().config).parse(rawDest) as Record<
        string,
        unknown
      >
      const [source, destination] = await Promise.all([
        srcConnector.check({ config: sourceConfig }),
        destConnector.check({ config: destConfig }),
      ])
      return { source, destination }
    },

    async *pipeline_read(
      pipeline: PipelineConfig,
      opts?: SyncOpts,
      input?: AsyncIterable<unknown>
    ): AsyncIterable<Message> {
      const baseContext = engineLogContext(pipeline)
      const connector = await resolver.resolveSource(pipeline.source.type)
      const { type: _, ...rawSrc } = pipeline.source
      const sourceConfig = z.fromJSONSchema(connector.spec().config).parse(rawSrc) as Record<
        string,
        unknown
      >
      const catalogMsg = await this.source_discover(pipeline.source)
      const catalog = buildCatalog(catalogMsg.streams, pipeline.streams)
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
      const destConfig = z.fromJSONSchema(connector.spec().config).parse(rawDest) as Record<
        string,
        unknown
      >
      const catalogMsg = await this.source_discover(pipeline.source)
      const catalog = buildCatalog(catalogMsg.streams, pipeline.streams)
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
      opts?: SyncOpts,
      input?: AsyncIterable<unknown>
    ): AsyncIterable<DestinationOutput> {
      await this.pipeline_setup(pipeline)
      // Pass state to read() but not stateLimit — stateLimit on sync controls destination output
      const writeOutput = this.pipeline_write(
        pipeline,
        this.pipeline_read(pipeline, { state: opts?.state }, input)
      )
      yield* takeLimits<DestinationOutput>({
        stateLimit: opts?.stateLimit,
        timeLimitMs: opts?.timeLimit ? opts.timeLimit * 1000 : undefined,
      })(writeOutput)
    },
  }
}
