import type { StateMessage, SyncParams } from './protocol'
import type { Destination, Source } from './protocol'
import { createEngine } from './engine'

/**
 * Run a sync pipeline: source.read → forward → destination.write → collect.
 *
 * Pure function — no database, no filesystem, no module discovery.
 * The caller imports source and destination explicitly and passes them in.
 */
export async function* runSync(
  config: SyncParams,
  source: Source,
  destination: Destination
): AsyncIterable<StateMessage> {
  yield* createEngine(config, { source, destination }).run()
}
