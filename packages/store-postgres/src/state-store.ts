import type pg from 'pg'

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
        `SELECT stream, state FROM "${schema}"."_sync_state" WHERE sync_id = $1`,
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
        `INSERT INTO "${schema}"."_sync_state" (sync_id, stream, state, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (sync_id, stream) DO UPDATE SET state = $3, updated_at = NOW()`,
        [syncId, stream, JSON.stringify(data)]
      )
    },

    async clear(syncId: string) {
      await pool.query(`DELETE FROM "${schema}"."_sync_state" WHERE sync_id = $1`, [syncId])
    },

    async close() {
      await pool.end()
    },
  }
}
