import type { PipelineConfig } from '@stripe/sync-engine'
import type { Pipeline } from './schemas.js'

/**
 * Convert a Pipeline into engine-ready PipelineConfig.
 *
 * The Pipeline's source/destination already use `name` as the discriminator,
 * matching the engine's PipelineConfig shape. Optional overrides are merged on top.
 */
export function resolve(opts: {
  pipeline: Pipeline
  sourceOverrides?: Record<string, unknown>
  destinationOverrides?: Record<string, unknown>
}): PipelineConfig {
  return {
    source: { ...opts.pipeline.source, ...opts.sourceOverrides },
    destination: { ...opts.pipeline.destination, ...opts.destinationOverrides },
    streams: opts.pipeline.streams,
  }
}
