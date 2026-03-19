import type {
  CheckResult,
  ConfiguredCatalog,
  ConfiguredStream,
  Message,
  StateMessage,
  Stream,
  SyncConfig,
} from './protocol'
import type { Destination, Source } from './protocol'
import type { RouterCallbacks } from './filters'
import { forward, collect } from './filters'

// MARK: - Engine interface

export interface Engine {
  check(): Promise<{ source: CheckResult; destination: CheckResult }>
  read(): AsyncIterable<Message>
  write(messages: AsyncIterable<Message>): AsyncIterable<StateMessage>
  run(): AsyncIterable<StateMessage>
}

// MARK: - Helpers

const stderrCallbacks: RouterCallbacks = {
  onLog: (message: string, level: string) => console.error(`[${level}] ${message}`),
  onError: (message: string, failureType: string) =>
    console.error(`[error:${failureType}] ${message}`),
  onStreamStatus: (stream: string, status: string) =>
    console.error(`[status] ${stream}: ${status}`),
}

/**
 * Build a ConfiguredCatalog from discovered streams, optionally filtered
 * by the streams listed in config.
 */
export function buildCatalog(
  discovered: Stream[],
  configStreams?: SyncConfig['streams']
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
  config: SyncConfig,
  connectors: { source: Source; destination: Destination },
  callbacks?: RouterCallbacks
): Engine {
  const cb = callbacks ?? stderrCallbacks

  // Lazy-cached catalog — discover is called at most once per engine instance.
  let _catalog: ConfiguredCatalog | null = null
  async function getCatalog(): Promise<ConfiguredCatalog> {
    if (!_catalog) {
      const msg = await connectors.source.discover({ config: config.source_config })
      _catalog = buildCatalog(msg.streams, config.streams)
    }
    return _catalog
  }

  return {
    async check() {
      const [source, destination] = await Promise.all([
        connectors.source.check({ config: config.source_config }),
        connectors.destination.check({ config: config.destination_config }),
      ])
      return { source, destination }
    },

    async *read() {
      const catalog = await getCatalog()
      yield* connectors.source.read({
        config: config.source_config,
        catalog,
        state: config.state,
      })
    },

    async *write(messages: AsyncIterable<Message>) {
      const catalog = await getCatalog()
      const forwarded = forward(messages, cb)
      const destOutput = connectors.destination.write({
        config: config.destination_config,
        catalog,
        messages: forwarded,
      })
      yield* collect(destOutput, cb)
    },

    async *run() {
      yield* this.write(this.read())
    },
  }
}
