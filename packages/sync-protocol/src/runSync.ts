import type {
  ConfiguredCatalog,
  ConfiguredStream,
  StateMessage,
  Stream,
  SyncConfig,
  Message,
  DestinationInput,
  DestinationOutput,
} from './types'
import type { Destination, Source } from './interfaces'
import { isDataMessage, isLogMessage, isErrorMessage, isStreamStatusMessage } from './filters'

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
 * Forward source messages to the destination.
 * RecordMessage + StateMessage pass through; logs/errors/status go to stderr.
 */
async function* forward(
  messages: AsyncIterableIterator<Message>
): AsyncIterableIterator<DestinationInput> {
  for await (const msg of messages) {
    if (isDataMessage(msg)) {
      yield msg
    } else if (isLogMessage(msg)) {
      console.error(`[${msg.level}] ${msg.message}`)
    } else if (isErrorMessage(msg)) {
      console.error(`[error:${msg.failure_type}] ${msg.message}`)
    } else if (isStreamStatusMessage(msg)) {
      console.error(`[status] ${msg.stream}: ${msg.status}`)
    }
  }
}

/**
 * Collect destination output. Yields StateMessage checkpoints;
 * routes errors/logs to stderr.
 */
async function* collect(
  output: AsyncIterableIterator<DestinationOutput>
): AsyncIterableIterator<StateMessage> {
  for await (const msg of output) {
    if (msg.type === 'state') {
      yield msg
    } else if (msg.type === 'log') {
      console.error(`[dest:${msg.level}] ${msg.message}`)
    } else if (msg.type === 'error') {
      console.error(`[dest:error:${msg.failure_type}] ${msg.message}`)
    }
  }
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

  // 3. Convert config.state → StateMessage[] for source resume
  const state: StateMessage[] = config.state
    ? Object.entries(config.state).map(([stream, data]) => ({
        type: 'state' as const,
        stream,
        data,
      }))
    : []

  // 4. Compose pipeline
  const sourceMessages = source.read({
    config: config.source_config,
    catalog,
    state: state.length > 0 ? state : undefined,
  })
  const forwarded = forward(sourceMessages)
  const destOutput = destination.write({
    config: config.destination_config,
    catalog,
    messages: forwarded,
  })

  // 5. Yield state checkpoints
  yield* collect(destOutput)
}
