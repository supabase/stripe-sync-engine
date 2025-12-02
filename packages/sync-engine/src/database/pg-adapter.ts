import pg, { PoolConfig } from 'pg'
import { DatabaseAdapter } from './adapter'

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
}
