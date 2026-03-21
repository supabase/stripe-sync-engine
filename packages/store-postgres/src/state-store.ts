import type pg from 'pg'

export interface PgStateStore {
  load(): Promise<Record<string, unknown> | undefined>
  set(stream: string, data: unknown): Promise<void>
  close(): Promise<void>
}

/**
 * Postgres-backed state store that persists per-stream cursor state
 * in a `_sync_state` table within the destination schema.
 *
 * The table is auto-created if it doesn't exist.
 */
export function createPgStateStore(pool: pg.Pool, schema: string): PgStateStore {
  const ensured = ensureTable(pool, schema)

  return {
    async load() {
      await ensured
      const { rows } = await pool.query<{ stream: string; state: unknown }>(
        `SELECT stream, state FROM "${schema}"."_sync_state"`
      )
      if (rows.length === 0) return undefined
      const result: Record<string, unknown> = {}
      for (const row of rows) {
        result[row.stream] = row.state
      }
      return result
    },

    async set(stream: string, data: unknown) {
      await ensured
      await pool.query(
        `INSERT INTO "${schema}"."_sync_state" (stream, state, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (stream) DO UPDATE SET state = $2, updated_at = NOW()`,
        [stream, JSON.stringify(data)]
      )
    },

    async close() {
      await pool.end()
    },
  }
}

async function ensureTable(pool: pg.Pool, schema: string): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "${schema}"."_sync_state" (
      stream TEXT PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
}
