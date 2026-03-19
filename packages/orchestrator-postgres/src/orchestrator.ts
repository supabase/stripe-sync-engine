import type {
  CatalogMessage,
  ConfiguredCatalog,
  Destination,
  DestinationInput,
  DestinationOutput,
  Message,
  Orchestrator,
  Source,
  StateMessage,
  Stream,
} from '@stripe/sync-protocol'
import type { PostgresStateManager } from './stateManager'
import { forward as routerForward, collect as routerCollect, type RouterCallbacks } from './router'

/**
 * Minimal Sync type for the orchestrator.
 * Matches the shape from packages/sync-engine/src/sync/types.ts.
 * Will be replaced with a re-export from @stripe/sync-protocol
 * once the Sync type is promoted there.
 */
export interface Sync {
  id: string
  account_id: string
  status: string
  source: Record<string, unknown>
  destination: Record<string, unknown>
  streams?: Array<{ name: string; [key: string]: unknown }>
  state?: Record<string, unknown>
}

/**
 * Postgres-backed orchestrator implementing the Orchestrator interface shape.
 *
 * Manages sync lifecycle: routing messages between source and destination,
 * persisting state checkpoints, and coordinating sync runs.
 *
 * `run()` is the supervisor: discovers catalog, loads state, composes the
 * source -> forward -> write -> collect pipeline, and persists checkpoints.
 */
export class PostgresOrchestrator implements Orchestrator<Sync> {
  readonly sync: Sync
  private stateManager: PostgresStateManager
  private callbacks: RouterCallbacks
  private abortController = new AbortController()

  constructor(sync: Sync, stateManager: PostgresStateManager, callbacks?: RouterCallbacks) {
    this.sync = sync
    this.stateManager = stateManager
    this.callbacks = callbacks ?? {}
  }

  /**
   * Sits between source and destination in a pipe.
   * Forwards RecordMessage and StateMessage to stdout (for destination).
   * Routes LogMessage, ErrorMessage, StreamStatusMessage to stderr.
   */
  forward(messages: AsyncIterableIterator<Message>): AsyncIterableIterator<DestinationInput> {
    return routerForward(messages, this.callbacks)
  }

  /**
   * Sits after destination in a pipe.
   * Reads destination output, persists StateMessage checkpoints to disk.
   * Routes ErrorMessage and LogMessage to stderr.
   */
  collect(output: AsyncIterableIterator<DestinationOutput>): AsyncIterableIterator<StateMessage> {
    return routerCollect(output, this.callbacks)
  }

  /**
   * Run the full sync: discover catalog, load state, compose pipeline, persist checkpoints.
   *
   * Data flow:
   *   source.read(streams, state)
   *     | this.forward()           -- filter to RecordMessage + StateMessage
   *     | destination.write(catalog) -- write records, yield output on commit
   *     | this.collect()           -- persist checkpoints, yield final states
   */
  async run(source: Source, destination: Destination): Promise<StateMessage[]> {
    // 1. Discover catalog from source
    const catalog = await source.discover({ config: {} })

    // 2. Load state from Sync.state -> StateMessage[]
    const state = this.loadState()

    // 3. Resolve streams from Sync config against catalog
    const streams = this.getStreams(catalog)

    // 4. Build ConfiguredCatalog from resolved streams
    const configuredCatalog: ConfiguredCatalog = {
      streams: streams.map((stream) => ({
        stream,
        sync_mode: 'full_refresh' as const,
        destination_sync_mode: 'overwrite' as const,
      })),
    }

    // 5. Compose pipeline: source.read -> forward -> destination.write -> collect
    const sourceMessages = source.read({ config: {}, catalog: configuredCatalog, state })
    const forwarded = this.forward(sourceMessages)
    const destOutput = destination.write({
      config: {},
      catalog: configuredCatalog,
      messages: forwarded,
    })
    const collected = this.collect(destOutput)

    // 5. Drain pipeline, collecting and persisting checkpoints
    const checkpoints: StateMessage[] = []
    for await (const msg of collected) {
      if (this.abortController.signal.aborted) {
        break
      }
      checkpoints.push(msg)
      this.persistState(msg)
    }

    return checkpoints
  }

  /**
   * Signal graceful shutdown.
   * Aborts the pipeline drain loop in run().
   */
  async stop(): Promise<void> {
    this.abortController.abort()
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Convert Sync.state (Record<string, unknown>) to StateMessage[].
   * Each key in the state record becomes a separate StateMessage for that stream.
   */
  private loadState(): StateMessage[] {
    const stateRecord = this.sync.state
    if (!stateRecord) return []

    return Object.entries(stateRecord).map(([stream, data]) => ({
      type: 'state' as const,
      stream,
      data,
    }))
  }

  /**
   * Resolve streams from Sync config against the discovered catalog.
   * If Sync.streams is set, use those names to filter catalog streams.
   * Otherwise, use all streams from the catalog.
   */
  private getStreams(catalog: CatalogMessage): Stream[] {
    if (this.sync.streams && this.sync.streams.length > 0) {
      const requestedNames = new Set(this.sync.streams.map((s) => s.name))
      return catalog.streams.filter((s) => requestedNames.has(s.name))
    }
    return catalog.streams
  }

  /**
   * Persist a state checkpoint by updating Sync.state[stream].
   * Mutates the Sync.state record in-place so subsequent reads see the latest state.
   */
  private persistState(msg: StateMessage): void {
    if (!this.sync.state) {
      this.sync.state = {}
    }
    this.sync.state[msg.stream] = msg.data
  }
}
