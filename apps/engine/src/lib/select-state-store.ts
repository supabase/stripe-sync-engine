import { noopStateStore } from './state-store.js'
import type { StateStore } from './state-store.js'
import type { SyncParams } from '@stripe/sync-protocol'

/**
 * Convention-based state store factory.
 *
 * Tries to import `@stripe/sync-state-${destination_name}` and call its
 * `createStateStore(destination_config)`. If the package is not installed or
 * doesn't export `createStateStore`, falls back to `noopStateStore()`.
 *
 * Uses `syncId = 'default'` — the HTTP layer has no per-sync identity concept.
 * The service layer, which does have sync UUIDs, calls `createStateStore` directly.
 */
export async function selectStateStore(
  params: SyncParams
): Promise<StateStore & { close?(): Promise<void> }> {
  try {
    const pkg = await import(`@stripe/sync-state-${params.destination_name}`)
    if (typeof pkg.createStateStore === 'function') {
      return pkg.createStateStore(params.destination_config) as StateStore & {
        close?(): Promise<void>
      }
    }
  } catch {
    // Package not installed — fall through to noop
  }
  return noopStateStore()
}
