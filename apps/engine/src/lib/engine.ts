import { z } from 'zod'
import {
  DestinationOutput,
  DiscoverOutput,
  CheckOutput,
  SetupOutput,
  TeardownOutput,
  Message,
  PipelineConfig,
  Stream,
  ConfiguredStream,
  ConfiguredCatalog,
  SyncOutput,
  SourceState,
  RecordMessage,
  SourceStateMessage,
  collectFirst,
  split,
  merge,
  map,
} from '@stripe/sync-protocol'

import { enforceCatalog, filterType, log, pipe, takeLimits } from './pipeline.js'
import { applySelection } from './destination-filter.js'
import type { ConnectorResolver } from './resolver.js'
import { logger } from '../logger.js'

// MARK: - Engine interface

export const SourceReadOptions = z.object({
  /** Aggregate state (per-stream + global) carried in from the previous sync run. */
  state: SourceState.optional(),
  /** Stop after emitting this many state messages (useful for paging). */
  state_limit: z.number().int().positive().optional(),
  /** Wall-clock time limit in seconds; the stream stops after this duration. */
  time_limit: z.number().positive().optional(),
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
 * Every pipeline operation returns AsyncIterable — everything is a stream.
 *
 * Implementations include:
 * - `createEngine()` — in-process, backed by connector instances directly
 * - `createRemoteEngine()` — HTTP client that forwards calls to an engine HTTP API
 */
export interface Engine {
  /** List all registered source connector types with their config schemas. */
  meta_sources_list(): Promise<{ items: ConnectorListItem[] }>
  /** Fetch metadata (config schema) for a single source connector type. */
  meta_sources_get(type: string): Promise<ConnectorInfo>
  /** List all registered destination connector types with their config schemas. */
  meta_destinations_list(): Promise<{ items: ConnectorListItem[] }>
  /** Fetch metadata (config schema) for a single destination connector type. */
  meta_destinations_get(type: string): Promise<ConnectorInfo>

  /**
   * Run connector `check()` for both source and destination.
   * Yields {@link CheckOutput} messages (connection_status, log, trace) tagged with `_emitted_by`.
   */
  pipeline_check(pipeline: PipelineConfig): AsyncIterable<CheckOutput>

  /**
   * Run connector `setup()` hooks for source and/or destination.
   * Yields {@link SetupOutput} messages (control, log, trace) tagged with `_emitted_by`.
   * Use `collectMessages(stream, 'control')` to extract config updates.
   *
   * Pass `only` to run a single side — useful for optimistic destination setup
   * (e.g. creating tables early in a UI flow) or isolating connectors when debugging.
   */
  pipeline_setup(
    pipeline: PipelineConfig,
    opts?: { only?: 'source' | 'destination' }
  ): AsyncIterable<SetupOutput>

  /**
   * Run connector `teardown()` hooks for source and/or destination.
   * Yields {@link TeardownOutput} messages (log, trace) tagged with `_emitted_by`.
   *
   * Pass `only` to run a single side — useful for isolating connectors when debugging.
   */
  pipeline_teardown(
    pipeline: PipelineConfig,
    opts?: { only?: 'source' | 'destination' }
  ): AsyncIterable<TeardownOutput>

  /**
   * Discover the streams available from a source.
   * Yields {@link DiscoverOutput} messages (catalog, log, trace).
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
   * Full sync: read → write, wired as a single streaming pipeline.
   * Yields {@link SyncOutput} messages: destination output (state, trace, log, eof)
   * plus source signals (control, trace, log) tagged with `_emitted_by`.
   */
  pipeline_sync(
    pipeline: PipelineConfig,
    opts?: SourceReadOptions,
    input?: AsyncIterable<unknown>
  ): AsyncIterable<SyncOutput>
}

function engineLogContext(pipeline: PipelineConfig): Record<string, unknown> {
  return {
    sourceName: pipeline.source.type,
    destinationName: pipeline.destination.type,
    configuredStreamCount: pipeline.streams?.length ?? 0,
    configuredStreams: pipeline.streams?.map((stream) => stream.name) ?? [],
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
 * We store only the user's minimal stream selection in `PipelineConfig.streams`
 * (name, sync_mode, fields, backfill_limit) and hydrate the full
 * `ConfiguredCatalog` at runtime by merging that selection with `discover()`
 * output. This means the catalog always reflects the current API shape (e.g.
 * new fields added upstream appear automatically), at the cost of re-running
 * discover on each operation. For source-stripe with the bundled spec this is
 * CPU-only — no HTTP calls — and the connector caches the result in-memory.
 *
 * Contrast with Airbyte, which persists the full `ConfiguredAirbyteCatalog`
 * after the initial discover and passes that saved snapshot to every
 * read()/write() without re-discovering.
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

/** Extract the connector-specific config from a nested { type, [type]: payload } envelope. */
function configPayload(envelope: {
  type: string
  [key: string]: unknown
}): Record<string, unknown> {
  return (envelope[envelope.type] as Record<string, unknown>) ?? {}
}

/** Helper to get spec config from a connector (spec() is now async iterable). */
async function getSpecConfig(
  connector: { spec(): AsyncIterable<Message> },
  rawConfig: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const specMsg = await collectFirst(connector.spec(), 'spec')

  return z.fromJSONSchema(specMsg.spec.config).parse(rawConfig) as Record<string, unknown>
}

/** Discover and build catalog for a pipeline. */
async function discoverCatalog(
  engine: Engine,
  pipeline: PipelineConfig
): Promise<{ catalog: ConfiguredCatalog; filteredCatalog: ConfiguredCatalog }> {
  const catalogMsg = await collectFirst(engine.source_discover(pipeline.source), 'catalog')
  const catalog = buildCatalog(catalogMsg.catalog.streams, pipeline.streams)
  const filteredCatalog = applySelection(catalog)
  return { catalog, filteredCatalog }
}

// MARK: - Factory

/** Tag each message with `_emitted_by` and `_ts`. */
function tag<T extends Message>(emitter: string): (msg: T) => T {
  return (msg) => ({ ...msg, _emitted_by: emitter, _ts: new Date().toISOString() })
}

/**
 * Create an in-process {@link Engine} backed by the given connector resolver.
 *
 * @param resolver - Resolves connector type names to connector instances.
 */
export async function createEngine(resolver: ConnectorResolver): Promise<Engine> {
  const engine: Engine = {
    async meta_sources_list() {
      return {
        items: [...resolver.sources()].map(([type, r]) => ({
          type,
          config_schema: r.rawConfigJsonSchema,
        })),
      }
    },

    async meta_sources_get(type) {
      const r = resolver.sources().get(type)
      if (!r) throw new Error(`Unknown source connector: ${type}`)
      return { config_schema: r.rawConfigJsonSchema }
    },

    async meta_destinations_list() {
      return {
        items: [...resolver.destinations()].map(([type, r]) => ({
          type,
          config_schema: r.rawConfigJsonSchema,
        })),
      }
    },

    async meta_destinations_get(type) {
      const r = resolver.destinations().get(type)
      if (!r) throw new Error(`Unknown destination connector: ${type}`)
      return { config_schema: r.rawConfigJsonSchema }
    },

    async *source_discover(sourceInput) {
      const connector = await resolver.resolveSource(sourceInput.type)
      const rawSrc = configPayload(sourceInput)
      const sourceConfig = await getSpecConfig(connector, rawSrc)
      yield* connector.discover({ config: sourceConfig })
    },

    async *pipeline_check(pipeline) {
      const baseContext = engineLogContext(pipeline)
      const [srcConnector, destConnector] = await Promise.all([
        resolver.resolveSource(pipeline.source.type),
        resolver.resolveDestination(pipeline.destination.type),
      ])
      const rawSrc = configPayload(pipeline.source)
      const rawDest = configPayload(pipeline.destination)
      const [sourceConfig, destConfig] = await Promise.all([
        getSpecConfig(srcConnector, rawSrc),
        getSpecConfig(destConnector, rawDest),
      ])

      const sourceTag = `source/${pipeline.source.type}`
      const destTag = `destination/${pipeline.destination.type}`

      yield* merge(
        withLoggedStream(
          'Engine source check',
          baseContext,
          map(srcConnector.check({ config: sourceConfig }), tag(sourceTag))
        ),
        withLoggedStream(
          'Engine destination check',
          baseContext,
          map(destConnector.check({ config: destConfig }), tag(destTag))
        )
      )
    },

    async *pipeline_setup(pipeline, opts?) {
      const baseContext = engineLogContext(pipeline)
      const runSource = opts?.only !== 'destination'
      const runDest = opts?.only !== 'source'

      const [srcConnector, destConnector] = await Promise.all([
        runSource ? resolver.resolveSource(pipeline.source.type) : null,
        runDest ? resolver.resolveDestination(pipeline.destination.type) : null,
      ])
      const [sourceConfig, destConfig] = await Promise.all([
        srcConnector ? getSpecConfig(srcConnector, configPayload(pipeline.source)) : null,
        destConnector ? getSpecConfig(destConnector, configPayload(pipeline.destination)) : null,
      ])

      const { catalog, filteredCatalog } = await discoverCatalog(engine, pipeline)

      const sourceTag = `source/${pipeline.source.type}`
      const destTag = `destination/${pipeline.destination.type}`

      yield* merge(
        runSource &&
          srcConnector?.setup &&
          withLoggedStream(
            'Engine source setup',
            baseContext,
            map(srcConnector.setup({ config: sourceConfig!, catalog }), tag(sourceTag))
          ),
        runDest &&
          destConnector?.setup &&
          withLoggedStream(
            'Engine destination setup',
            baseContext,
            map(
              destConnector.setup({ config: destConfig!, catalog: filteredCatalog }),
              tag(destTag)
            )
          )
      )
    },

    async *pipeline_teardown(pipeline, opts?) {
      const baseContext = engineLogContext(pipeline)
      const runSource = opts?.only !== 'destination'
      const runDest = opts?.only !== 'source'

      const [srcConnector, destConnector] = await Promise.all([
        runSource ? resolver.resolveSource(pipeline.source.type) : null,
        runDest ? resolver.resolveDestination(pipeline.destination.type) : null,
      ])
      const [sourceConfig, destConfig] = await Promise.all([
        srcConnector ? getSpecConfig(srcConnector, configPayload(pipeline.source)) : null,
        destConnector ? getSpecConfig(destConnector, configPayload(pipeline.destination)) : null,
      ])

      const sourceTag = `source/${pipeline.source.type}`
      const destTag = `destination/${pipeline.destination.type}`

      yield* merge(
        runSource &&
          srcConnector?.teardown &&
          withLoggedStream(
            'Engine source teardown',
            baseContext,
            map(srcConnector.teardown({ config: sourceConfig! }), tag(sourceTag))
          ),
        runDest &&
          destConnector?.teardown &&
          withLoggedStream(
            'Engine destination teardown',
            baseContext,
            map(destConnector.teardown({ config: destConfig! }), tag(destTag))
          )
      )
    },

    async *pipeline_read(pipeline, opts?, input?) {
      const baseContext = engineLogContext(pipeline)
      const connector = await resolver.resolveSource(pipeline.source.type)
      const rawSrc = configPayload(pipeline.source)
      const sourceConfig = await getSpecConfig(connector, rawSrc)
      const { catalog } = await discoverCatalog(engine, pipeline)
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
      yield* takeLimits({
        state_limit: opts?.state_limit,
        time_limit: opts?.time_limit,
      })(parsed)
    },

    async *pipeline_write(pipeline, messages) {
      const baseContext = engineLogContext(pipeline)
      const connector = await resolver.resolveDestination(pipeline.destination.type)
      const rawDest = configPayload(pipeline.destination)
      const destConfig = await getSpecConfig(connector, rawDest)
      const { filteredCatalog } = await discoverCatalog(engine, pipeline)

      const destInput = pipe(
        messages,
        enforceCatalog(filteredCatalog),
        log,
        filterType('record', 'source_state')
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

    async *pipeline_sync(pipeline, opts?, input?) {
      const baseContext = engineLogContext(pipeline)
      const sourceTag = `source/${pipeline.source.type}`
      const destTag = `destination/${pipeline.destination.type}`
      const now = () => new Date().toISOString()

      // Read from source (pass state but not state_limit — state_limit controls sync output)
      const readOutput = engine.pipeline_read(pipeline, { state: opts?.state }, input)

      // Split: data + eof → destination path, source signals → caller
      // Eof from pipeline_read is excluded from source signals (pipeline_sync adds its own)
      const isDataOrEof = (msg: Message): msg is RecordMessage | SourceStateMessage =>
        msg.type === 'record' || msg.type === 'source_state' || msg.type === 'eof'
      const [dataStream, sourceSignals] = split(readOutput, isDataOrEof)

      // Set up destination inline — we need control of the stream split
      const destConnector = await resolver.resolveDestination(pipeline.destination.type)
      const rawDest = configPayload(pipeline.destination)
      const destConfig = await getSpecConfig(destConnector, rawDest)
      const { filteredCatalog } = await discoverCatalog(engine, pipeline)

      const destInput = pipe(
        dataStream,
        enforceCatalog(filteredCatalog),
        log,
        filterType('record', 'source_state')
      )
      const destOutput = destConnector.write(
        { config: destConfig, catalog: filteredCatalog },
        destInput
      )
      const parsedDest = withLoggedStream('Engine destination write', baseContext, destOutput)

      // Tag origin on both streams, narrowing to SyncOutput
      const taggedDest: AsyncIterable<SyncOutput> = map(parsedDest, (msg) => ({
        ...DestinationOutput.parse(msg),
        _emitted_by: destTag,
        _ts: now(),
      }))
      const taggedSource: AsyncIterable<SyncOutput> = map(sourceSignals, (msg) =>
        SyncOutput.parse({ ...msg, _emitted_by: sourceTag, _ts: now() })
      )

      // Merge both streams and apply limits
      yield* takeLimits<SyncOutput>({
        state_limit: opts?.state_limit,
        time_limit: opts?.time_limit,
      })(merge(taggedDest, taggedSource))
    },
  }
  return engine
}
