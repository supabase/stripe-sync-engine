/**
 * pg-compatible client interface for use with pg-node-migrations.
 * This is the minimal interface required by the migration library.
 */
export interface PgCompatibleClient {
  query(
    sql: string | { text: string; values?: unknown[] }
  ): Promise<{ rows: unknown[]; rowCount: number }>
}

/**
 * Database adapter interface for abstracting database operations.
 * This allows sync-engine to work with different database clients:
 * - pg (Node.js) - for CLI, tests, existing deployments
 * - postgres.js (Node.js + Deno) - for Supabase Edge Functions
 */
export interface DatabaseAdapter {
  /**
   * Execute a SQL query with optional parameters.
   * @param sql - The SQL query string with $1, $2, etc. placeholders
   * @param params - Optional array of parameter values
   * @returns Query result with rows and rowCount
   */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }>

  /**
   * Close all connections and clean up resources.
   */
  end(): Promise<void>

  /**
   * Execute a function while holding a PostgreSQL advisory lock.
   * Adapters that don't support locking should just execute fn() directly.
   *
   * @param lockId - Integer lock ID (use hashToInt32 to convert string keys)
   * @param fn - Function to execute while holding the lock
   * @returns Result of the function
   */
  withAdvisoryLock<T>(lockId: number, fn: () => Promise<T>): Promise<T>

  /**
   * Returns a pg-compatible client for use with libraries that expect a pg.Client interface.
   * Used by pg-node-migrations to run database migrations.
   */
  toPgClient(): PgCompatibleClient
}
