import { createEngine, pipe, persistState } from '@stripe/sync-engine'
import type {
  DestinationOutput,
  Message,
  ConnectorResolver,
  CheckResult,
  StateStore as PipelineStateStore,
} from '@stripe/sync-engine'
import type { PipelineStore, LogSink, StateStore } from './stores.js'
import type { Pipeline } from './schemas.js'
import { resolve } from './resolve.js'
import { TemporalBridge } from '../temporal/bridge.js'
import type { TemporalOptions } from '../temporal/bridge.js'

export type { TemporalOptions } from '../temporal/bridge.js'

// MARK: - Async queue

/** Minimal async queue — push values in, iterate them out. */
function createAsyncQueue<T>() {
  const buffer: T[] = []
  let pending: ((result: IteratorResult<T, undefined>) => void) | null = null

  function push(value: T) {
    if (pending) {
      const resolve = pending
      pending = null
      resolve({ value, done: false })
    } else {
      buffer.push(value)
    }
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T, undefined>> {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift()!, done: false as const })
          }
          return new Promise((resolve) => {
            pending = resolve
          })
        },
      }
    },
  }

  return { push, iterable }
}

// MARK: - SyncService

export type SyncServiceOptions = {
  pipelines: PipelineStore
  states: StateStore
  logs: LogSink
  connectors: ConnectorResolver
  /** Extra config fields merged on top of source config (env vars, CLI flags). */
  sourceOverrides?: Record<string, unknown>
  /** Extra config fields merged on top of destination config (env vars, CLI flags). */
  destinationOverrides?: Record<string, unknown>
  /** When set, sync lifecycle is managed by Temporal instead of running in-process. */
  temporal?: TemporalOptions
}

export class SyncService {
  private pipelines: PipelineStore
  private states: StateStore
  private logs: LogSink
  private connectors: ConnectorResolver
  private sourceOverrides?: Record<string, unknown>
  private destinationOverrides?: Record<string, unknown>
  readonly temporal?: TemporalBridge
  /** Registry of active input queues keyed by pipeline_id. */
  private inputQueues: Map<string, (event: unknown) => void> = new Map()

  constructor(opts: SyncServiceOptions) {
    this.pipelines = opts.pipelines
    this.states = opts.states
    this.logs = opts.logs
    this.connectors = opts.connectors
    this.sourceOverrides = opts.sourceOverrides
    this.destinationOverrides = opts.destinationOverrides
    if (opts.temporal) {
      this.temporal = new TemporalBridge(
        opts.temporal.client,
        opts.temporal.taskQueue,
        opts.pipelines
      )
    }
  }

  /** Create a scoped state writer for a single pipeline run. */
  private makeStateWriter(pipelineId: string): PipelineStateStore {
    return {
      get: async () => this.states.get(pipelineId),
      set: async (stream, data) => {
        await this.states.set(pipelineId, stream, data)
        this.logs.write(pipelineId, {
          level: 'debug',
          message: `checkpoint: ${stream}`,
          stream,
          timestamp: new Date().toISOString(),
        })
      },
    }
  }

  /** Resolve pipeline config into an engine instance. */
  private async resolveEngine(pipelineId: string) {
    const pipeline = await this.pipelines.get(pipelineId)
    const source = await this.connectors.resolveSource(pipeline.source.type)
    const destination = await this.connectors.resolveDestination(pipeline.destination.type)
    const params = resolve({
      pipeline,
      sourceOverrides: this.sourceOverrides,
      destinationOverrides: this.destinationOverrides,
    })
    const engine = createEngine(params, { source, destination }, this.makeStateWriter(pipelineId))
    return { engine, pipeline }
  }

  /**
   * Push an event to the running pipeline with the given id.
   * In Temporal mode, signals the workflow. Otherwise pushes to the in-process queue.
   */
  push_event(pipelineId: string, event: unknown): void {
    if (this.temporal) {
      this.temporal.pushEvent(pipelineId, event)
      return
    }
    const push = this.inputQueues.get(pipelineId)
    if (push) push(event)
  }

  async setup(pipelineId: string): Promise<void> {
    const { engine } = await this.resolveEngine(pipelineId)
    await engine.setup()
  }

  async teardown(pipelineId: string): Promise<void> {
    const { engine } = await this.resolveEngine(pipelineId)
    await engine.teardown()
  }

  async check(pipelineId: string): Promise<{ source: CheckResult; destination: CheckResult }> {
    const { engine } = await this.resolveEngine(pipelineId)
    return engine.check()
  }

  async *read(pipelineId: string, $stdin?: AsyncIterable<unknown>): AsyncIterable<Message> {
    const { engine } = await this.resolveEngine(pipelineId)
    yield* engine.read($stdin)
  }

  async *write(
    pipelineId: string,
    messages: AsyncIterable<Message>
  ): AsyncIterable<DestinationOutput> {
    const { engine } = await this.resolveEngine(pipelineId)
    const stateWriter = this.makeStateWriter(pipelineId)
    yield* pipe(engine.write(messages), persistState(stateWriter))
  }

  async *run(
    pipelineId: string,
    $stdin?: AsyncIterable<unknown>
  ): AsyncIterable<DestinationOutput> {
    const pipeline = await this.pipelines.get(pipelineId)
    const source = await this.connectors.resolveSource(pipeline.source.type)
    const destination = await this.connectors.resolveDestination(pipeline.destination.type)

    let activeStdin = $stdin
    let queuePush: ((event: unknown) => void) | undefined

    // Set up per-pipeline webhook queue when no explicit stdin provided
    if (!$stdin) {
      const queue = createAsyncQueue<unknown>()
      queuePush = queue.push
      activeStdin = queue.iterable
      this.inputQueues.set(pipelineId, queuePush)
    }

    try {
      const params = resolve({
        pipeline,
        sourceOverrides: this.sourceOverrides,
        destinationOverrides: this.destinationOverrides,
      })

      const stateWriter = this.makeStateWriter(pipelineId)
      const engine = createEngine(params, { source, destination }, stateWriter)
      await engine.setup()

      const sourceMessages = engine.read(activeStdin)
      yield* pipe(engine.write(sourceMessages), persistState(stateWriter))
    } finally {
      if (queuePush) {
        this.inputQueues.delete(pipelineId)
      }
    }
  }
}
