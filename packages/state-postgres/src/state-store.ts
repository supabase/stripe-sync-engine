import pg from 'pg'
import type { PoolConfig } from 'pg'
import { sql, withPgConnectProxy } from '@stripe/sync-util-postgres'

function sslConfigFromConnectionString(connStr: string): PoolConfig['ssl'] {
  try {
    const sslmode = new URL(connStr).searchParams.get('sslmode')
    if (sslmode === 'disable') return false
    if (sslmode === 'verify-ca' || sslmode === 'verify-full') return true
    if (sslmode === 'require') return { rejectUnauthorized: false }
    return false
  } catch {
    return false
  }
}

export interface StateStore {
  get(syncId: string): Promise<Record<string, unknown> | undefined>
  set(syncId: string, stream: string, data: unknown): Promise<void>
  clear(syncId: string): Promise<void>
}

/**
 * Postgres-backed state store that persists per-stream cursor state
 * in a `_sync_state` table within the destination schema.
 *
 * Callers must run migrations (including 0002_sync_state) before using this store.
 */
export function createPgStateStore(
  pool: pg.Pool,
  schema: string
): StateStore & { close(): Promise<void> } {
  return {
    async get(syncId: string) {
      const { rows } = await pool.query<{ stream: string; state: unknown }>(
        sql`SELECT stream, state FROM "${schema}"."_sync_state" WHERE sync_id = $1`,
        [syncId]
      )
      if (rows.length === 0) return undefined
      const result: Record<string, unknown> = {}
      for (const row of rows) {
        result[row.stream] = row.state
      }
      return result
    },

    async set(syncId: string, stream: string, data: unknown) {
      await pool.query(
        sql`INSERT INTO "${schema}"."_sync_state" (sync_id, stream, state, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (sync_id, stream) DO UPDATE SET state = $3, updated_at = NOW()`,
        [syncId, stream, JSON.stringify(data)]
      )
    },

    async clear(syncId: string) {
      await pool.query(sql`DELETE FROM "${schema}"."_sync_state" WHERE sync_id = $1`, [syncId])
    },

    async close() {
      await pool.end()
    },
  }
}

/** Engine-compatible state store scoped to a single sync_id. */
export interface ScopedStateStore {
  get(): Promise<Record<string, unknown> | undefined>
  set(stream: string, data: unknown): Promise<void>
}

/**
 * Wraps `createPgStateStore` to scope all operations to a single `syncId`.
 * Returns the engine-compatible `ScopedStateStore` interface.
 */
export function createScopedPgStateStore(
  pool: pg.Pool,
  schema: string,
  syncId: string
): ScopedStateStore {
  const store = createPgStateStore(pool, schema)
  return {
    get: () => store.get(syncId),
    set: (stream, data) => store.set(syncId, stream, data),
  }
}

/**
 * Convention entry point: ensures the `_sync_state` table exists.
 * Called by `selectStateStore` before creating the state store.
 */
export async function setupStateStore(config: {
  connection_string: string
  schema?: string
}): Promise<void> {
  const pool = new pg.Pool(
    withPgConnectProxy({
      connectionString: config.connection_string,
      ssl: sslConfigFromConnectionString(config.connection_string),
    })
  )
  const schema = config.schema ?? 'public'
  try {
    await pool.query(sql`
      CREATE TABLE IF NOT EXISTS "${schema}"."_sync_state" (
        sync_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (sync_id, stream)
      )
    `)
  } finally {
    await pool.end()
  }
}

/**
 * Convention entry point: creates a pool-owning, engine-compatible state store.
 * `syncId` defaults to `'default'` — HTTP API callers share a single sync slot
 * per destination; the service layer passes a real UUID for multi-tenancy.
 */
export function createStateStore(
  config: { connection_string: string; schema?: string },
  syncId = 'default'
): ScopedStateStore & { close(): Promise<void> } {
  const pool = new pg.Pool(
    withPgConnectProxy({
      connectionString: config.connection_string,
      ssl: sslConfigFromConnectionString(config.connection_string),
    })
  )
  const scoped = createScopedPgStateStore(pool, config.schema ?? 'public', syncId)
  return {
    ...scoped,
    close: () => pool.end(),
  }
}
