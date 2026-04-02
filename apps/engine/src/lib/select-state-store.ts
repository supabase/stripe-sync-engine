import { readonlyStateStore } from './state-store.js'
import type { StateStore } from './state-store.js'
import type { PipelineConfig } from '@stripe/sync-protocol'

/**
 * Tries to resolve a destination-colocated state store.
 *
 * Imports `@stripe/sync-state-${destination.name}` and calls its
 * `createStateStore(destConfig)`. Not all destinations support this —
 * Postgres does (state table alongside synced data), Google Sheets doesn't.
 * Falls back to a read-only no-op store when unavailable.
 *
 * If the package exports a `setupStateStore(destConfig)` function,
 * it is called first to ensure the state table exists (runs migrations).
 */
export async function maybeDestinationStateStore(
  params: PipelineConfig
): Promise<StateStore & { close?(): Promise<void> }> {
  try {
    const { name: destName, ...destConfig } = params.destination
    const pkg = await import(`@stripe/sync-state-${destName}`)
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
