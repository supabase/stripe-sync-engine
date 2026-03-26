import type { SyncParams } from '@stripe/sync-engine'
import type { Pipeline } from './schemas.js'

/** Fields on source/destination config that are routing, not connector config. */
const SELECTOR_FIELDS = new Set(['type'])

/** Strip selector fields (type) from a config section. */
function stripSelectorFields(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !SELECTOR_FIELDS.has(k)))
}

/**
 * Convert a Pipeline into engine-ready SyncParams.
 *
 * Strips `type` from source/destination before passing config to the engine.
 * Optional overrides are merged on top (highest priority).
 */
export function resolve(opts: {
  pipeline: Pipeline
  state?: Record<string, unknown>
  sourceOverrides?: Record<string, unknown>
  destinationOverrides?: Record<string, unknown>
}): SyncParams {
  const sourceType = opts.pipeline.source.type
  const destType = opts.pipeline.destination.type

  const sourceConfig = stripSelectorFields(opts.pipeline.source)
  const destConfig = stripSelectorFields(opts.pipeline.destination)

  return {
    source_name: sourceType,
    destination_name: destType,
    source_config: { ...sourceConfig, ...opts.sourceOverrides },
    destination_config: { ...destConfig, ...opts.destinationOverrides },
    streams: opts.pipeline.streams,
    state: opts.state,
  }
}
