import pg, { PoolConfig } from 'pg'
import { DatabaseAdapter, PgCompatibleClient } from './adapter'

/**
 * Database adapter implementation using node-postgres (pg).
 * This is the default adapter for Node.js environments.
 */
export class PgAdapter implements DatabaseAdapter {
  private pool: pg.Pool

  constructor(config: PoolConfig) {
    this.pool = new pg.Pool(config)
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await this.pool.query(sql, params)
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount ?? 0,
    }
  }

  async end(): Promise<void> {
    await this.pool.end()
  }

  /**
   * Execute a function while holding a PostgreSQL advisory lock.
   * Uses a dedicated connection to ensure lock is held for the duration.
   */
  async withAdvisoryLock<T>(lockId: number, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect()

    try {
      // Acquire lock on this specific connection
      await client.query('SELECT pg_advisory_lock($1)', [lockId])

      // Execute function
      return await fn()
    } finally {
      // Release lock on this specific connection
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [lockId])
      } finally {
        // Always release connection back to pool
        client.release()
      }
    }
  }

  /**
   * Returns a pg-compatible client for use with libraries that expect pg.Client.
   * Used by pg-node-migrations to run database migrations.
   */
  toPgClient(): PgCompatibleClient {
    return {
      query: async (sql: string | { text: string; values?: unknown[] }) => {
        const result =
          typeof sql === 'string'
            ? await this.pool.query(sql)
            : await this.pool.query(sql.text, sql.values)
        return { rows: result.rows, rowCount: result.rowCount ?? 0 }
      },
    }
  }
}
