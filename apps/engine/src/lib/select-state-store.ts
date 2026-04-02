import { readonlyStateStore } from './state-store.js'
import type { StateStore } from './state-store.js'
import type { PipelineConfig } from '@stripe/sync-protocol'

/**
 * Tries to resolve a destination-colocated state store.
 *
 * Imports `@stripe/sync-state-${destination.type}` and calls its
 * `createStateStore(destConfig)`. Not all destinations support this —
 * Postgres does (state table alongside synced data), Google Sheets doesn't.
 * Falls back to a read-only no-op store when unavailable.
 *
 * If the package exports a `setupStateStore(destConfig)` function,
 * it is called first to ensure the state table exists (runs migrations).
 *
 * When to use this vs readonlyStateStore:
 * - Use `maybeDestinationStateStore` when the engine owns state durability —
 *   e.g. standalone CLI usage where there is no external state manager.
 * - Use `readonlyStateStore(params.state)` when the caller owns state —
 *   e.g. the HTTP API (state flows in via X-State header, out via NDJSON stream)
 *   or Temporal workflows (workflow memory is the source of truth).
 *   Writing state to the destination DB in those cases creates unexpected tables.
 */
export async function maybeDestinationStateStore(
  params: PipelineConfig
): Promise<StateStore & { close?(): Promise<void> }> {
  try {
    const { type: destType, ...destConfig } = params.destination
    const pkg = await import(`@stripe/sync-state-${destType}`)
    if (typeof pkg.createStateStore === 'function') {
      // Run migrations if the package provides a setup function
      if (typeof pkg.setupStateStore === 'function') {
        await pkg.setupStateStore(destConfig)
      }
      return pkg.createStateStore(destConfig) as StateStore & {
        close?(): Promise<void>
      }
    }
  } catch {
    // Package not installed — fall through to readonly
  }
  return readonlyStateStore()
}
