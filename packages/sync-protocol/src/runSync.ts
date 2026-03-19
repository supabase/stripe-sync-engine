import type { ConfiguredCatalog, ConfiguredStream, StateMessage, Stream, SyncConfig } from './types'
import type { Destination, Source } from './interfaces'
import { forward, collect } from './filters'

const stderrCallbacks = {
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
function buildCatalog(
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

/**
 * Run a sync pipeline: source.read → forward → destination.write → collect.
 *
 * Pure function — no database, no filesystem, no module discovery.
 * The caller imports source and destination explicitly and passes them in.
 */
export async function* runSync(
  config: SyncConfig,
  source: Source,
  destination: Destination
): AsyncIterableIterator<StateMessage> {
  // 1. Discover available streams
  const catalogMsg = await source.discover({ config: config.source_config })

  // 2. Build configured catalog, filtered by config.streams
  const catalog = buildCatalog(catalogMsg.streams, config.streams)

  // 3. Compose pipeline
  const sourceMessages = source.read({
    config: config.source_config,
    catalog,
    state: config.state,
  })
  const forwarded = forward(sourceMessages, stderrCallbacks)
  const destOutput = destination.write({
    config: config.destination_config,
    catalog,
    messages: forwarded,
  })

  // 5. Yield state checkpoints
  yield* collect(destOutput, stderrCallbacks)
}
