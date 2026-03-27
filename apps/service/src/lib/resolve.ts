import type { PipelineParams } from '@stripe/sync-engine'
import type { Pipeline } from './schemas.js'

/**
 * Convert a Pipeline into engine-ready PipelineParams.
 *
 * The Pipeline's source/destination already use `name` as the discriminator,
 * matching the engine's PipelineParams shape. Optional overrides are merged on top.
 */
export function resolve(opts: {
  pipeline: Pipeline
  sourceOverrides?: Record<string, unknown>
  destinationOverrides?: Record<string, unknown>
}): PipelineParams {
  return {
    source: { ...opts.pipeline.source, ...opts.sourceOverrides },
    destination: { ...opts.pipeline.destination, ...opts.destinationOverrides },
    streams: opts.pipeline.streams,
  }
}
