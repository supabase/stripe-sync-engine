import pg from 'pg'
import {
  createPgStateStore,
  runMigrationsFromContent,
  genericBootstrapMigrations,
} from '@stripe/sync-state-postgres'
import type { SyncParams } from '@stripe/sync-protocol'
import type { StateStore } from './state-store.js'
import { noopStateStore } from './state-store.js'

/** Extract the Postgres connection URL from resolved destination config. */
function getPostgresUrl(destConfig: Record<string, unknown>): string | undefined {
  return (destConfig['url'] as string) ?? (destConfig['connection_string'] as string)
}

/** Extract the Postgres schema from resolved destination config. */
function getPostgresSchema(destConfig: Record<string, unknown>): string {
  return (destConfig['schema'] as string) ?? 'stripe'
}

/** Destination names that indicate a Postgres-backed state store should be used. */
const POSTGRES_DEST_NAMES = new Set([
  'postgres',
  'destination-postgres',
  '@stripe/sync-destination-postgres',
])

export interface SelectedStateStore {
  store: StateStore
  /** Release any resources held by the store (e.g. close the Postgres pool). */
  close(): Promise<void>
}

/**
 * Auto-select a StateStore based on the destination connector name.
 *
 * - Postgres destination → creates a PgStateStore backed by the destination DB
 *   (runs the necessary `_sync_state` migration if needed).
 * - Everything else → returns a noopStateStore (no persistence).
 *
 * The caller is responsible for calling `close()` when finished.
 */
export async function selectStateStore(params: SyncParams): Promise<SelectedStateStore> {
  if (POSTGRES_DEST_NAMES.has(params.destination_name)) {
    const destConfig = params.destination_config as Record<string, unknown>
    const pgUrl = getPostgresUrl(destConfig)
    if (pgUrl) {
      const schema = getPostgresSchema(destConfig)
      await runMigrationsFromContent(
        { databaseUrl: pgUrl, schemaName: schema },
        genericBootstrapMigrations
      )
      const pool = new pg.Pool({ connectionString: pgUrl })
      const store = createPgStateStore(pool, schema)
      return {
        store,
        async close() {
          await store.close?.()
        },
      }
    }
  }

  return { store: noopStateStore(), close: async () => {} }
}
