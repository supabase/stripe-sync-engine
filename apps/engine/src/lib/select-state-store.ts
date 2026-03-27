import { noopStateStore } from './state-store.js'
import type { StateStore } from './state-store.js'
import type { SyncParams } from '@stripe/sync-protocol'

/**
 * Convention-based state store factory.
 *
 * Tries to import `@stripe/sync-state-${destination.name}` and call its
 * `createStateStore(destConfig)`. If the package is not installed or
 * doesn't export `createStateStore`, falls back to `noopStateStore()`.
 *
 * If the package exports a `setupStateStore(destConfig)` function,
 * it is called first to ensure the state table exists (runs migrations).
 *
 * Uses `syncId = 'default'` — the HTTP layer has no per-sync identity concept.
 * The service layer, which does have sync UUIDs, calls `createStateStore` directly.
 */
export async function selectStateStore(
  params: SyncParams
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
    // Package not installed — fall through to noop
  }
  return noopStateStore()
}
