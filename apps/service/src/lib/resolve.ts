import type { SyncParams } from '@stripe/sync-engine'
import type { Pipeline } from './schemas.js'

/**
 * Convert a Pipeline into engine-ready SyncParams.
 *
 * The Pipeline's source/destination already use `name` as the discriminator,
 * matching the engine's SyncParams shape. Optional overrides are merged on top.
 */
export function resolve(opts: {
  pipeline: Pipeline
  state?: Record<string, unknown>
  sourceOverrides?: Record<string, unknown>
  destinationOverrides?: Record<string, unknown>
}): SyncParams {
  return {
    source: { ...opts.pipeline.source, ...opts.sourceOverrides },
    destination: { ...opts.pipeline.destination, ...opts.destinationOverrides },
    streams: opts.pipeline.streams,
    state: opts.state,
  }
}
