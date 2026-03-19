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
  RouterCallbacks,
} from '@stripe/sync-protocol'
import { forward as routerForward, collect as routerCollect } from '@stripe/sync-protocol'
import type { FsSyncConfig } from './config'
import { FsStateStore } from './state'

export { FsStateStore } from './state'
export { loadSyncConfig, saveSyncConfig } from './config'
export type { FsSyncConfig } from './config'

/**
 * Filesystem-backed orchestrator for local dev and standalone CLI usage.
 *
 * State is persisted as JSON files in `{stateDir}/{syncId}/{stream}.json`.
 * Uses `forward()` and `collect()` from `@stripe/sync-protocol` for message routing.
 */
export class FsOrchestrator implements Orchestrator<FsSyncConfig> {
  readonly sync: FsSyncConfig
  private stateStore: FsStateStore
  private callbacks: RouterCallbacks
  private abortController = new AbortController()

  constructor(sync: FsSyncConfig, stateDir: string, callbacks?: RouterCallbacks) {
    this.sync = sync
    this.stateStore = new FsStateStore(stateDir)
    this.callbacks = callbacks ?? {}
  }

  forward(messages: AsyncIterableIterator<Message>): AsyncIterableIterator<DestinationInput> {
    return routerForward(messages, this.callbacks)
  }

  collect(output: AsyncIterableIterator<DestinationOutput>): AsyncIterableIterator<StateMessage> {
    return routerCollect(output, this.callbacks)
  }

  async run(source: Source, destination: Destination): Promise<StateMessage[]> {
    // 1. Discover catalog from source
    const catalog = await source.discover({ config: this.sync.source })

    // 2. Load state from filesystem
    const stateRecord = this.stateStore.loadState(this.sync.id)
    const state: StateMessage[] = Object.entries(stateRecord).map(([stream, data]) => ({
      type: 'state' as const,
      stream,
      data,
    }))

    // 3. Resolve streams
    const streams = this.getStreams(catalog)

    // 4. Build ConfiguredCatalog
    const configuredCatalog: ConfiguredCatalog = {
      streams: streams.map((stream) => ({
        stream,
        sync_mode: 'full_refresh' as const,
        destination_sync_mode: 'overwrite' as const,
      })),
    }

    // 5. Compose pipeline
    const sourceMessages = source.read({
      config: this.sync.source,
      catalog: configuredCatalog,
      state,
    })
    const forwarded = this.forward(sourceMessages)
    const destOutput = destination.write({
      config: this.sync.destination,
      catalog: configuredCatalog,
      messages: forwarded,
    })
    const collected = this.collect(destOutput)

    // 6. Drain pipeline, persisting checkpoints
    const checkpoints: StateMessage[] = []
    for await (const msg of collected) {
      if (this.abortController.signal.aborted) break
      checkpoints.push(msg)
      this.stateStore.saveStreamState(this.sync.id, msg.stream, msg.data)
    }

    return checkpoints
  }

  async stop(): Promise<void> {
    this.abortController.abort()
  }

  private getStreams(catalog: CatalogMessage): Stream[] {
    if (this.sync.streams && this.sync.streams.length > 0) {
      const requestedNames = new Set(this.sync.streams.map((s) => s.name))
      return catalog.streams.filter((s) => requestedNames.has(s.name))
    }
    return catalog.streams
  }
}
