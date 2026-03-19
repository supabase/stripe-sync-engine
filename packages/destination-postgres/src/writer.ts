import pg, { QueryResult } from 'pg'
import { pg as sql } from 'yesql'
import { QueryUtils, type InsertColumn } from './QueryUtils'
import type { DestinationWriter } from './destinationWriter'
import { METADATA_TABLES, type PostgresConfig, type RawJsonUpsertOptions } from './types'

export class PostgresDestinationWriter implements DestinationWriter {
  pool: pg.Pool

  constructor(private config: PostgresConfig) {
    this.pool = new pg.Pool(config.poolConfig)
  }

  private get syncSchema(): string {
    return this.config.syncSchema ?? this.config.schema
  }

  private schemaForTable(table: string): string {
    return METADATA_TABLES.has(table) ? this.syncSchema : this.config.schema
  }

  async delete(table: string, id: string): Promise<boolean> {
    const schema = this.schemaForTable(table)
    const prepared = sql(`
    delete from "${schema}"."${table}"
    where id = :id
    returning id;
    `)({ id })
    const { rows } = await this.query(prepared.text, prepared.values)
    return rows.length > 0
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

  async upsertManyWithTimestampProtection<
    T extends {
      [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  >(
    entries: T[],
    table: string,
    accountId: string,
    syncTimestamp?: string,
    upsertOptions?: RawJsonUpsertOptions,
    schemaOverride?: string
  ): Promise<T[]> {
    const timestamp = syncTimestamp || new Date().toISOString()

    if (!entries.length) return []

    const targetSchema = table.startsWith('_')
      ? this.syncSchema
      : (schemaOverride ?? this.config.schema)

    // Max 5 in parallel to avoid exhausting connection pool
    const chunkSize = 5
    const results: pg.QueryResult<T>[] = []

    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize)

      const queries: Promise<pg.QueryResult<T>>[] = []
      chunk.forEach((entry) => {
        // Internal tables (starting with _) use old column-based format with yesql
        if (table.startsWith('_')) {
          const columns = Object.keys(entry).filter(
            (k) => k !== 'last_synced_at' && k !== 'account_id'
          )

          const upsertSql = `
            INSERT INTO "${targetSchema}"."${table}" (
              ${columns.map((c) => `"${c}"`).join(', ')}, "last_synced_at", "account_id"
            )
            VALUES (
              ${columns.map((c) => `:${c}`).join(', ')}, :last_synced_at, :account_id
            )
            ON CONFLICT ("id")
            DO UPDATE SET
              ${columns.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')},
              "last_synced_at" = :last_synced_at,
              "account_id" = EXCLUDED."account_id"
            WHERE "${table}"."last_synced_at" IS NULL
               OR "${table}"."last_synced_at" < :last_synced_at
            RETURNING *
          `

          const cleansed = this.cleanseArrayField(entry)
          cleansed.last_synced_at = timestamp
          cleansed.account_id = accountId
          const prepared = sql(upsertSql, { useNullForMissing: true })(cleansed)
          queries.push(this.pool.query(prepared.text, prepared.values))
        } else {
          // Raw JSON upsert path: store entry as _raw_data jsonb
          const conflictTarget = upsertOptions?.conflictTarget ?? ['id']
          const extraColumns = upsertOptions?.extraColumns ?? []
          if (!conflictTarget.length) {
            throw new Error(`Invalid upsert config for ${table}: conflictTarget must be non-empty`)
          }

          // Build column list: _raw_data + any extra typed columns + metadata
          const columns: InsertColumn[] = [
            { column: '_raw_data', pgType: 'jsonb', value: JSON.stringify(entry) },
            ...extraColumns.map((c) => ({
              column: c.column,
              pgType: c.pgType,
              value: entry[c.entryKey],
            })),
            { column: '_last_synced_at', pgType: 'timestamptz', value: timestamp },
            { column: '_account_id', pgType: 'text', value: accountId },
          ]

          // Validate all values are present
          for (const c of columns) {
            if (c.value === undefined) {
              throw new Error(`Missing required value for ${table}.${c.column}`)
            }
          }

          const { sql: upsertSql, params } = QueryUtils.buildRawJsonUpsertQuery(
            targetSchema,
            table,
            columns,
            conflictTarget,
            extraColumns.map((c) => c.column) // Pass extra column names for ON CONFLICT UPDATE
          )
          queries.push(this.pool.query(upsertSql, params))
        }
      })

      const chunkResults = await Promise.all(queries)
      results.push(...chunkResults)

      // if upsert returns 0 rows for non-empty input
      const chunkRowCount = chunkResults.reduce((sum, r) => sum + (r.rowCount ?? 0), 0)
      if (chunkRowCount === 0 && chunk.length > 0) {
        console.warn(
          `[upsert] 0 rows returned for ${targetSchema}.${table} ` +
            `(input: ${chunk.length} entries, timestamp: ${timestamp}, accountId: ${accountId}). `
        )
      }
    }

    return results.flatMap((it) => it.rows)
  }

  private cleanseArrayField(obj: {
    [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
  }): {
    [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
  } {
    const cleansed = { ...obj }
    Object.keys(cleansed).map((k) => {
      const data = cleansed[k]
      if (Array.isArray(data)) {
        cleansed[k] = JSON.stringify(data)
      }
    })
    return cleansed
  }

  async findMissingEntries(table: string, ids: string[]): Promise<string[]> {
    if (!ids.length) return []

    const schema = this.schemaForTable(table)
    const prepared = sql(`
    select id from "${schema}"."${table}"
    where id=any(:ids::text[]);
    `)({ ids })

    const { rows } = await this.query(prepared.text, prepared.values)
    const existingIds = rows.map((it) => it.id)

    const missingIds = ids.filter((it) => !existingIds.includes(it))

    return missingIds
  }

  async columnExists(table: string, column: string): Promise<boolean> {
    const result = await this.query(
      `SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = $1
          AND table_name = $2
          AND column_name = $3
      )`,
      [this.config.schema, table, column]
    )
    return result.rows[0].exists
  }

  async deleteRemovedActiveEntitlements(
    customerId: string,
    currentActiveEntitlementIds: string[]
  ): Promise<{ rowCount: number }> {
    const prepared = sql(`
      delete from "${this.config.schema}"."active_entitlements"
      where customer = :customerId and id <> ALL(:currentActiveEntitlementIds::text[]);
      `)({ customerId, currentActiveEntitlementIds })
    const { rowCount } = await this.query(prepared.text, prepared.values)
    return { rowCount: rowCount || 0 }
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
   * Call this when you're done using the PostgresDestinationWriter instance.
   */
  async close(): Promise<void> {
    await this.pool.end()
  }
}
