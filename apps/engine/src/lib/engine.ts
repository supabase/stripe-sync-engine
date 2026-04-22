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
  SyncState,
  parseSyncState,
  createEngineMessageFactory,
  collectFirst,
  merge,
  map,
  withAbortOnReturn,
  EofMessage,
} from '@stripe/sync-protocol'

const engineMsg = createEngineMessageFactory()

import { log } from '../logger.js'
import { enforceCatalog, filterType, tapLog, pipe, takeLimits, limitSource } from './pipeline.js'
import { createInitialProgress, progressReducer } from './progress/index.js'
import { stateReducer, isProgressTrigger } from './state-reducer.js'
import { applySelection, excludeTerminalStreams } from './destination-filter.js'
import type { ConnectorResolver } from './resolver.js'

// MARK: - Engine interface

export const SourceReadOptions = z.object({
  /** Sync state. Normalized at runtime to SyncState for backward compatibility. */
  state: z.unknown().optional(),
  /** Wall-clock time limit in seconds; the stream stops after this duration. */
  time_limit: z.number().positive().optional(),
  /** Identifies the current sync run. If it differs from state.sync_run.run_id, run progress is reset. */
  run_id: z.string().optional(),
})
export interface SourceReadOptions {
  state?:
    | SyncState
    | { streams: Record<string, unknown>; global: Record<string, unknown> }
    | Record<string, unknown>
  time_limit?: number
  run_id?: string
}

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
   * Run connector `check()` for source and/or destination.
   * Yields {@link CheckOutput} messages (connection_status, log, trace) tagged with `_emitted_by`.
   *
   * Pass `only` to run a single side.
   */
  pipeline_check(
    pipeline: PipelineConfig,
    opts?: { only?: 'source' | 'destination' }
  ): AsyncIterable<CheckOutput>

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
          time_range: cfg.time_range,
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

/** Helper to get spec from a connector and parse config. */
async function getSpec(
  connector: { spec(): AsyncIterable<Message> },
  rawConfig: Record<string, unknown>
): Promise<{ config: Record<string, unknown>; streamStateSchema?: z.ZodType }> {
  const specMsg = await collectFirst(connector.spec(), 'spec')
  const config = z.fromJSONSchema(specMsg.spec.config).parse(rawConfig) as Record<string, unknown>
  const streamStateSchema = specMsg.spec.source_state_stream
    ? z.fromJSONSchema(specMsg.spec.source_state_stream)
    : undefined
  return { config, streamStateSchema }
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

/** Resolve both connectors, configs, catalog, and state for a pipeline. */
async function resolvePipeline(
  resolver: ConnectorResolver,
  engine: Engine,
  pipeline: PipelineConfig,
  state?: unknown
) {
  const [srcConnector, destConnector] = await Promise.all([
    resolver.resolveSource(pipeline.source.type),
    resolver.resolveDestination(pipeline.destination.type),
  ])
  const [srcSpec, destSpec] = await Promise.all([
    getSpec(srcConnector, configPayload(pipeline.source)),
    getSpec(destConnector, configPayload(pipeline.destination)),
  ])
  const { catalog, filteredCatalog } = await discoverCatalog(engine, pipeline)
  const normalizedState = parseSyncState(state, srcSpec.streamStateSchema)
  return {
    source: { connector: srcConnector, config: srcSpec.config },
    destination: { connector: destConnector, config: destSpec.config },
    catalog,
    filteredCatalog,
    state: normalizedState,
  }
}

/**
 * Inject `time_range.lt` into each ConfiguredStream from the frozen `time_ceiling`.
 *
 * The source's `accounted_range` + reconciliation handles `gte` and resumption.
 * The engine only sets the upper bound.
 *
 * Mutates `catalog.streams` in place.
 */
/** Pure: returns a new catalog with time_range.lt set to timeCeiling on eligible streams. */
export function withTimeRanges(
  catalog: ConfiguredCatalog,
  timeCeiling?: string
): ConfiguredCatalog {
  if (!timeCeiling) return catalog
  return {
    ...catalog,
    streams: catalog.streams.map((cs) =>
      cs.supports_time_range === false
        ? cs
        : {
            ...cs,
            time_range: { ...cs.time_range, ...(!cs.time_range?.lt && { lt: timeCeiling }) },
          }
    ),
  }
}

// MARK: - Helpers

/** Tag each message with `_emitted_by` and `_ts`. */
function tag<T extends Message>(emitter: string): (msg: T) => T {
  return (msg) => ({ ...msg, _emitted_by: emitter, _ts: new Date().toISOString() })
}

const SETUP_TIME_LIMIT_S = 30

/** Apply takeLimits and strip the eof marker, emitting an error log on timeout. */
function withSetupTimeout<T extends { type: string }>(
  stream: AsyncIterable<T>,
  label: string,
  opts: { timeLimitS: number }
): AsyncIterable<T> {
  const limited = takeLimits({ time_limit: opts.timeLimitS })(stream)
  return {
    [Symbol.asyncIterator]() {
      const iter = limited[Symbol.asyncIterator]()
      return {
        async next() {
          while (true) {
            const result = await iter.next()
            if (result.done) return { value: undefined as unknown as T, done: true } as const
            if ((result.value as { type: string }).type === 'eof') {
              const eof = result.value as EofMessage
              if (eof.eof.has_more) {
                log.error(`${label} setup timed out after ${opts.timeLimitS}s`)
              }
              return { value: undefined as unknown as T, done: true } as const
            }
            return { value: result.value as T, done: false } as const
          }
        },
        return: iter.return?.bind(iter),
        throw: iter.throw?.bind(iter),
      } as AsyncIterator<T>
    },
  }
}

/** Stamp a message as engine-emitted. */
function emit(msg: Record<string, unknown>): SyncOutput {
  return { ...msg, _emitted_by: 'engine', _ts: new Date().toISOString() } as unknown as SyncOutput
}

/** Accumulate source state from messages. Pure. */

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
      const { config: sourceConfig } = await getSpec(connector, rawSrc)
      yield* connector.discover({ config: sourceConfig })
    },

    async *pipeline_check(pipeline, opts?) {
      const runSource = opts?.only !== 'destination'
      const runDest = opts?.only !== 'source'

      const [srcConnector, destConnector] = await Promise.all([
        runSource ? resolver.resolveSource(pipeline.source.type) : null,
        runDest ? resolver.resolveDestination(pipeline.destination.type) : null,
      ])
      const [srcSpec, destSpec] = await Promise.all([
        srcConnector ? getSpec(srcConnector, configPayload(pipeline.source)) : null,
        destConnector ? getSpec(destConnector, configPayload(pipeline.destination)) : null,
      ])

      const sourceTag = `source/${pipeline.source.type}`
      const destTag = `destination/${pipeline.destination.type}`

      yield* merge(
        runSource && srcConnector && map(srcConnector.check({ config: srcSpec!.config }), tag(sourceTag)),
        runDest && destConnector && map(destConnector.check({ config: destSpec!.config }), tag(destTag))
      )
    },

    async *pipeline_setup(pipeline, opts?) {
      const runSource = opts?.only !== 'destination'
      const runDest = opts?.only !== 'source'

      log.info(
        {
          source_type: pipeline.source.type,
          destination_type: pipeline.destination.type,
          run_source: runSource,
          run_destination: runDest,
        },
        'Starting pipeline setup'
      )

      log.debug({ runSource, runDest }, 'pipeline_setup: resolving connectors')
      const [srcConnector, destConnector] = await Promise.all([
        runSource ? resolver.resolveSource(pipeline.source.type) : null,
        runDest ? resolver.resolveDestination(pipeline.destination.type) : null,
      ])
      log.debug('pipeline_setup: resolving specs')
      const [srcSpec, destSpec] = await Promise.all([
        srcConnector ? getSpec(srcConnector, configPayload(pipeline.source)) : null,
        destConnector ? getSpec(destConnector, configPayload(pipeline.destination)) : null,
      ])

      log.debug('pipeline_setup: discovering catalog')
      const { catalog, filteredCatalog } = await discoverCatalog(engine, pipeline)
      log.debug(
        { streams: catalog.streams.length },
        'pipeline_setup: catalog discovered, running setup hooks'
      )

      const sourceTag = `source/${pipeline.source.type}`
      const destTag = `destination/${pipeline.destination.type}`

      yield* merge(
        runSource &&
          srcConnector?.setup &&
          map(
            withSetupTimeout(srcConnector.setup({ config: srcSpec!.config, catalog }), sourceTag, {
              timeLimitS: SETUP_TIME_LIMIT_S,
            }),
            tag(sourceTag)
          ),
        runDest &&
          destConnector?.setup &&
          map(
            withSetupTimeout(
              destConnector.setup({ config: destSpec!.config, catalog: filteredCatalog }),
              destTag,
              { timeLimitS: SETUP_TIME_LIMIT_S }
            ),
            tag(destTag)
          )
      )
      log.debug('pipeline_setup: setup hooks complete')
    },

    async *pipeline_teardown(pipeline, opts?) {
      const runSource = opts?.only !== 'destination'
      const runDest = opts?.only !== 'source'

      const [srcConnector, destConnector] = await Promise.all([
        runSource ? resolver.resolveSource(pipeline.source.type) : null,
        runDest ? resolver.resolveDestination(pipeline.destination.type) : null,
      ])
      const [srcSpec, destSpec] = await Promise.all([
        srcConnector ? getSpec(srcConnector, configPayload(pipeline.source)) : null,
        destConnector ? getSpec(destConnector, configPayload(pipeline.destination)) : null,
      ])

      const sourceTag = `source/${pipeline.source.type}`
      const destTag = `destination/${pipeline.destination.type}`

      yield* merge(
        runSource &&
          srcConnector?.teardown &&
          map(srcConnector.teardown({ config: srcSpec!.config }), tag(sourceTag)),
        runDest &&
          destConnector?.teardown &&
          map(destConnector.teardown({ config: destSpec!.config }), tag(destTag))
      )
    },

    pipeline_read(pipeline, opts?, input?) {
      return withAbortOnReturn((signal) =>
        (async function* (): AsyncGenerator<Message> {
          const p = await resolvePipeline(resolver, engine, pipeline, opts?.state)
          const catalogWithRanges = withTimeRanges(
            p.catalog,
            p.state?.sync_run?.time_ceiling
          )
          const raw = p.source.connector.read(
            { config: p.source.config, catalog: catalogWithRanges, state: p.state?.source },
            input
          )
          const parsed = map(raw, (msg) => Message.parse(msg))
          yield* takeLimits({
            time_limit: opts?.time_limit,
            signal,
          })(parsed) as AsyncIterable<Message>
        })()
      )
    },

    pipeline_write(pipeline, messages) {
      return withAbortOnReturn(() =>
        (async function* () {
          const p = await resolvePipeline(resolver, engine, pipeline)
          const destInput = pipe(
            map(messages, (msg) => Message.parse(msg)),
            enforceCatalog(p.filteredCatalog),
            tapLog,
            filterType('record', 'source_state')
          )
          const destOutput = p.destination.connector.write(
            { config: p.destination.config, catalog: p.filteredCatalog },
            destInput
          )
          for await (const msg of destOutput) {
            yield DestinationOutput.parse(msg)
          }
        })()
      )
    },

    pipeline_sync(pipeline, opts?, input?) {
      return withAbortOnReturn<SyncOutput>((signal) =>
        (async function* () {
          const p = await resolvePipeline(resolver, engine, pipeline, opts?.state)

          const isContinuation = opts?.run_id != null && p.state?.sync_run.run_id === opts.run_id
          const activeFilteredCatalog = isContinuation
            ? excludeTerminalStreams(p.filteredCatalog, p.state?.sync_run.progress)
            : p.filteredCatalog

          // Run reducer first so time_ceiling is correct for a new run_id.
          const streamNames = activeFilteredCatalog.streams.map((s) => s.stream.name)
          let syncState = stateReducer(p.state, {
            type: 'initialize',
            stream_names: streamNames,
            run_id: opts?.run_id,
          })
          let requestProgress = createInitialProgress(streamNames)

          const catalogWithRanges = withTimeRanges(p.catalog, syncState.sync_run.time_ceiling)
          const activeCatalog = isContinuation
            ? excludeTerminalStreams(catalogWithRanges, p.state?.sync_run.progress)
            : catalogWithRanges

          // Source → destination pipeline. The destination is the sole consumer,
          // giving natural pull-based backpressure with zero intermediate buffering.
          const sourceOutput = p.source.connector.read(
            { config: p.source.config, catalog: activeCatalog, state: p.state?.source },
            input
          )

          // Graceful close: limits apply to the source side. On soft/hard
          // deadline or abort, limitSource closes the source iterator; the
          // destination then sees end-of-input, runs its finally (e.g.
          // flushAll), and yields any post-teardown messages back through
          // destOutput. The engine synthesizes its own eof after destOutput
          // drains.
          const gate = limitSource(sourceOutput, {
            time_limit: opts?.time_limit,
            signal,
          })

          const destInput = pipe(gate.iterable, enforceCatalog(activeFilteredCatalog), tapLog)
          const destOutput = p.destination.connector.write(
            { config: p.destination.config, catalog: activeFilteredCatalog },
            destInput
          )

          for await (const raw of destOutput) {
            const msg = {
              ...raw,
              _ts: (raw as { _ts?: string })._ts ?? new Date().toISOString(),
            } as Message
            syncState = stateReducer(syncState, msg)
            requestProgress = progressReducer(requestProgress, msg)

            if (msg.type !== 'record') {
              yield msg as SyncOutput
            }
            if (isProgressTrigger(msg)) yield emit(engineMsg.progress(syncState.sync_run.progress))
          }

          const runProgress = syncState.sync_run.progress
          yield emit(
            engineMsg.eof({
              status: runProgress.derived.status,
              has_more: gate.stopped,
              ending_state: syncState,
              run_progress: runProgress,
              request_progress: requestProgress,
            })
          )
        })()
      )
    },
  }
  return engine
}
