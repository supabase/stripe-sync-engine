import postgres from 'postgres'
import { DatabaseAdapter } from './adapter'

export interface PostgresJsConfig {
  connectionString: string
  max?: number
}

/**
 * Database adapter implementation using postgres.js.
 * Works in Node.js, Deno, Bun, and Cloudflare Workers.
 */
export class PostgresJsAdapter implements DatabaseAdapter {
  private sql: postgres.Sql

  constructor(config: PostgresJsConfig) {
    this.sql = postgres(config.connectionString, {
      max: config.max ?? 10,
      prepare: false, // Required for Supabase connection pooling
    })
  }

  async query<T = Record<string, unknown>>(
    sqlQuery: string,
    params?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    const result = await this.sql.unsafe<(T & postgres.Row)[]>(
      sqlQuery,
      params as postgres.ParameterOrJSON<never>[]
    )
    return {
      rows: [...result] as T[],
      rowCount: result.count ?? result.length,
    }
  }

  async end(): Promise<void> {
    await this.sql.end()
  }

  /**
   * Execute a function while holding a PostgreSQL advisory lock.
   * Uses a transaction to ensure lock is held for the duration.
   */
  async withAdvisoryLock<T>(lockId: number, fn: () => Promise<T>): Promise<T> {
    // postgres.js doesn't have a dedicated connection pool like pg,
    // so we use a transaction to ensure we're on the same connection
    const result = await this.sql.begin(async (tx: postgres.TransactionSql) => {
      // Acquire lock
      await tx`SELECT pg_advisory_xact_lock(${lockId})`
      // Execute function - lock is automatically released when transaction ends
      return await fn()
    })
    return result as T
  }
}
