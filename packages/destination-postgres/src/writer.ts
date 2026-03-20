import pg, { QueryResult } from 'pg'
import type { PostgresConfig } from './types'

export class PostgresDestinationWriter {
  pool: pg.Pool

  constructor(private config: PostgresConfig) {
    this.pool = new pg.Pool(config.poolConfig)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query(text: string, params?: any[]): Promise<QueryResult> {
    return this.pool.query(text, params)
  }

  async upsertMany<
    T extends {
      [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  >(entries: T[], table: string): Promise<T[]> {
    if (!entries.length) return []

    // Max 5 in parallel to avoid exhausting connection pool
    const chunkSize = 5
    const results: pg.QueryResult<T>[] = []

    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize)

      const queries: Promise<pg.QueryResult<T>>[] = []
      chunk.forEach((entry) => {
        // Store entire entry as _raw_data jsonb (id will be auto-generated from _raw_data->>'id')
        const rawData = JSON.stringify(entry)

        // Use explicit parameter placeholders to avoid yesql parsing issues with ::jsonb cast
        const upsertSql = `
          INSERT INTO "${this.config.schema}"."${table}" ("_raw_data")
          VALUES ($1::jsonb)
          ON CONFLICT (id)
          DO UPDATE SET
            "_raw_data" = EXCLUDED."_raw_data"
          RETURNING *
        `

        queries.push(this.pool.query(upsertSql, [rawData]))
      })

      results.push(...(await Promise.all(queries)))
    }

    return results.flatMap((it) => it.rows)
  }

  /**
   * Hash a string to a 32-bit integer for use with PostgreSQL advisory locks.
   * Uses a simple hash algorithm that produces consistent results.
   */
  private hashToInt32(key: string): number {
    let hash = 0
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return hash
  }

  /**
   * Acquire a PostgreSQL advisory lock for the given key.
   * This lock is automatically released when the connection is closed or explicitly released.
   * Advisory locks are session-level and will block until the lock is available.
   *
   * @param key - A string key to lock on (will be hashed to an integer)
   */
  async acquireAdvisoryLock(key: string): Promise<void> {
    const lockId = this.hashToInt32(key)
    await this.query('SELECT pg_advisory_lock($1)', [lockId])
  }

  /**
   * Release a PostgreSQL advisory lock for the given key.
   *
   * @param key - The same string key used to acquire the lock
   */
  async releaseAdvisoryLock(key: string): Promise<void> {
    const lockId = this.hashToInt32(key)
    await this.query('SELECT pg_advisory_unlock($1)', [lockId])
  }

  /**
   * Execute a function while holding an advisory lock.
   * The lock is automatically released after the function completes (success or error).
   *
   * IMPORTANT: This acquires a dedicated connection from the pool and holds it for the
   * duration of the function execution. PostgreSQL advisory locks are session-level,
   * so we must use the same connection for lock acquisition, operations, and release.
   *
   * @param key - A string key to lock on (will be hashed to an integer)
   * @param fn - The function to execute while holding the lock
   * @returns The result of the function
   */
  async withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockId = this.hashToInt32(key)
    const client = await this.pool.connect()

    try {
      // Acquire lock on this specific connection
      await client.query('SELECT pg_advisory_lock($1)', [lockId])

      // Execute function with this locked connection
      // The function will still use the pool for its queries, but the lock
      // ensures only one instance can execute at a time
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
   * Closes the database connection pool and cleans up resources.
   */
  async close(): Promise<void> {
    await this.pool.end()
  }
}
