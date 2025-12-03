import pg, { PoolConfig, QueryResult } from 'pg'
import { pg as sql } from 'yesql'

type PostgresConfig = {
  schema: string
  poolConfig: PoolConfig
}

/**
 * All Stripe tables that store account-related data.
 * Ordered for safe cascade deletion: dependencies first, then parent tables last.
 *
 * Note: Backfill order is defined separately in resourceRegistry (stripeSync.ts)
 * using the `order` field, since deletion order != creation order.
 */
const ORDERED_STRIPE_TABLES = [
  'subscription_items',
  'subscriptions',
  'subscription_schedules',
  'checkout_session_line_items',
  'checkout_sessions',
  'tax_ids',
  'charges',
  'refunds',
  'credit_notes',
  'disputes',
  'early_fraud_warnings',
  'invoices',
  'payment_intents',
  'payment_methods',
  'setup_intents',
  'prices',
  'plans',
  'products',
  'features',
  'active_entitlements',
  'reviews',
  '_managed_webhooks',
  'customers',
  '_sync_obj_run', // Must be deleted before _sync_run (foreign key)
  '_sync_run',
] as const

// Tables that use `account_id` instead of `_account_id` (migration 0049)
const TABLES_WITH_ACCOUNT_ID: ReadonlySet<string> = new Set(['_managed_webhooks'])

export class PostgresClient {
  pool: pg.Pool

  constructor(private config: PostgresConfig) {
    this.pool = new pg.Pool(config.poolConfig)
  }

  async delete(table: string, id: string): Promise<boolean> {
    const prepared = sql(`
    delete from "${this.config.schema}"."${table}"
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
  >(entries: T[], table: string, accountId: string, syncTimestamp?: string): Promise<T[]> {
    const timestamp = syncTimestamp || new Date().toISOString()

    if (!entries.length) return []

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
            INSERT INTO "${this.config.schema}"."${table}" (
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
          // Store entire entry as _raw_data jsonb (id will be auto-generated from _raw_data->>'id')
          const rawData = JSON.stringify(entry)

          // Use explicit parameter placeholders to avoid yesql parsing issues with ::jsonb cast
          const upsertSql = `
            INSERT INTO "${this.config.schema}"."${table}" ("_raw_data", "_last_synced_at", "_account_id")
            VALUES ($1::jsonb, $2, $3)
            ON CONFLICT (id)
            DO UPDATE SET
              "_raw_data" = EXCLUDED."_raw_data",
              "_last_synced_at" = $2,
              "_account_id" = EXCLUDED."_account_id"
            WHERE "${table}"."_last_synced_at" IS NULL
               OR "${table}"."_last_synced_at" < $2
            RETURNING *
          `

          queries.push(this.pool.query(upsertSql, [rawData, timestamp, accountId]))
        }
      })

      results.push(...(await Promise.all(queries)))
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

    const prepared = sql(`
    select id from "${this.config.schema}"."${table}"
    where id=any(:ids::text[]);
    `)({ ids })

    const { rows } = await this.query(prepared.text, prepared.values)
    const existingIds = rows.map((it) => it.id)

    const missingIds = ids.filter((it) => !existingIds.includes(it))

    return missingIds
  }

  // Account management methods

  async upsertAccount(
    accountData: {
      id: string
      raw_data: any // eslint-disable-line @typescript-eslint/no-explicit-any
    },
    apiKeyHash: string
  ): Promise<void> {
    const rawData = JSON.stringify(accountData.raw_data)

    // Upsert account and add API key hash to array if not already present
    // Note: id is auto-generated from _raw_data->>'id'
    await this.query(
      `INSERT INTO "${this.config.schema}"."accounts" ("_raw_data", "api_key_hashes", "first_synced_at", "_last_synced_at")
       VALUES ($1::jsonb, ARRAY[$2], now(), now())
       ON CONFLICT (id)
       DO UPDATE SET
         "_raw_data" = EXCLUDED."_raw_data",
         "api_key_hashes" = (
           SELECT ARRAY(
             SELECT DISTINCT unnest(
               COALESCE("${this.config.schema}"."accounts"."api_key_hashes", '{}') || ARRAY[$2]
             )
           )
         ),
         "_last_synced_at" = now(),
         "_updated_at" = now()`,
      [rawData, apiKeyHash]
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAllAccounts(): Promise<any[]> {
    const result = await this.query(
      `SELECT _raw_data FROM "${this.config.schema}"."accounts"
       ORDER BY _last_synced_at DESC`
    )
    return result.rows.map((row) => row._raw_data)
  }

  /**
   * Looks up an account ID by API key hash
   * Uses the GIN index on api_key_hashes for fast lookups
   * @param apiKeyHash - SHA-256 hash of the Stripe API key
   * @returns Account ID if found, null otherwise
   */
  async getAccountIdByApiKeyHash(apiKeyHash: string): Promise<string | null> {
    const result = await this.query(
      `SELECT id FROM "${this.config.schema}"."accounts"
       WHERE $1 = ANY(api_key_hashes)
       LIMIT 1`,
      [apiKeyHash]
    )
    return result.rows.length > 0 ? result.rows[0].id : null
  }

  /**
   * Looks up full account data by API key hash
   * @param apiKeyHash - SHA-256 hash of the Stripe API key
   * @returns Account raw data if found, null otherwise
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAccountByApiKeyHash(apiKeyHash: string): Promise<any | null> {
    const result = await this.query(
      `SELECT _raw_data FROM "${this.config.schema}"."accounts"
       WHERE $1 = ANY(api_key_hashes)
       LIMIT 1`,
      [apiKeyHash]
    )
    return result.rows.length > 0 ? result.rows[0]._raw_data : null
  }

  private getAccountIdColumn(table: (typeof ORDERED_STRIPE_TABLES)[number]): string {
    return TABLES_WITH_ACCOUNT_ID.has(table) ? 'account_id' : '_account_id'
  }

  async getAccountRecordCounts(accountId: string): Promise<{ [tableName: string]: number }> {
    const counts: { [tableName: string]: number } = {}

    for (const table of ORDERED_STRIPE_TABLES) {
      const accountIdColumn = this.getAccountIdColumn(table)
      const result = await this.query(
        `SELECT COUNT(*) as count FROM "${this.config.schema}"."${table}"
         WHERE "${accountIdColumn}" = $1`,
        [accountId]
      )
      counts[table] = parseInt(result.rows[0].count)
    }

    return counts
  }

  async deleteAccountWithCascade(
    accountId: string,
    useTransaction: boolean
  ): Promise<{ [tableName: string]: number }> {
    const deletionCounts: { [tableName: string]: number } = {}

    try {
      if (useTransaction) {
        await this.query('BEGIN')
      }

      // Delete from all dependent tables
      for (const table of ORDERED_STRIPE_TABLES) {
        const accountIdColumn = this.getAccountIdColumn(table)
        const result = await this.query(
          `DELETE FROM "${this.config.schema}"."${table}"
           WHERE "${accountIdColumn}" = $1`,
          [accountId]
        )
        deletionCounts[table] = result.rowCount || 0
      }

      // Finally, delete the account itself
      const accountResult = await this.query(
        `DELETE FROM "${this.config.schema}"."accounts"
         WHERE "id" = $1`,
        [accountId]
      )
      deletionCounts['accounts'] = accountResult.rowCount || 0

      if (useTransaction) {
        await this.query('COMMIT')
      }
    } catch (error) {
      if (useTransaction) {
        await this.query('ROLLBACK')
      }
      throw error
    }

    return deletionCounts
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

  // =============================================================================
  // Observable Sync System Methods
  // =============================================================================
  // These methods support long-running syncs with full observability.
  // Uses two tables: _sync_run (parent) and _sync_obj_run (children)
  // RunKey = (accountId, runStartedAt) - natural composite key

  /**
   * Cancel stale runs (running but no object updated in 5 minutes).
   * Called before creating a new run to clean up crashed syncs.
   * Only cancels runs that have objects AND none have recent activity.
   * Runs without objects yet (just created) are not considered stale.
   */
  async cancelStaleRuns(accountId: string): Promise<void> {
    // Find runs where:
    // 1. Run has at least one object
    // 2. None of those objects have been updated in the last 5 minutes
    await this.query(
      `UPDATE "${this.config.schema}"."_sync_run" r
       SET status = 'error',
           error_message = 'Auto-cancelled: stale (no update in 5 min)',
           completed_at = now()
       WHERE r."_account_id" = $1
         AND r.status = 'running'
         AND EXISTS (
           SELECT 1 FROM "${this.config.schema}"."_sync_obj_run" o
           WHERE o."_account_id" = r."_account_id"
             AND o.run_started_at = r.started_at
         )
         AND NOT EXISTS (
           SELECT 1 FROM "${this.config.schema}"."_sync_obj_run" o
           WHERE o."_account_id" = r."_account_id"
             AND o.run_started_at = r.started_at
             AND o.updated_at >= now() - interval '5 minutes'
         )`,
      [accountId]
    )
  }

  /**
   * Get or create a sync run for this account.
   * Returns existing run if one is active, otherwise creates new one.
   * Auto-cancels stale runs before checking.
   *
   * @returns RunKey with isNew flag, or null if constraint violation (race condition)
   */
  async getOrCreateSyncRun(
    accountId: string,
    triggeredBy?: string
  ): Promise<{ accountId: string; runStartedAt: Date; isNew: boolean } | null> {
    // 1. Auto-cancel stale runs
    await this.cancelStaleRuns(accountId)

    // 2. Check for existing active run
    const existing = await this.query(
      `SELECT "_account_id", started_at FROM "${this.config.schema}"."_sync_run"
       WHERE "_account_id" = $1 AND status = 'running'`,
      [accountId]
    )

    if (existing.rows.length > 0) {
      const row = existing.rows[0]
      return { accountId: row._account_id, runStartedAt: row.started_at, isNew: false }
    }

    // 3. Try to create new run (EXCLUDE constraint prevents duplicates)
    // Use date_trunc to ensure millisecond precision for JavaScript Date compatibility
    try {
      const result = await this.query(
        `INSERT INTO "${this.config.schema}"."_sync_run" ("_account_id", triggered_by, started_at)
         VALUES ($1, $2, date_trunc('milliseconds', now()))
         RETURNING "_account_id", started_at`,
        [accountId, triggeredBy ?? null]
      )
      const row = result.rows[0]
      return { accountId: row._account_id, runStartedAt: row.started_at, isNew: true }
    } catch (error: unknown) {
      // Only return null for exclusion constraint violation (concurrent run)
      if (error instanceof Error && 'code' in error && error.code === '23P01') {
        return null
      }
      throw error
    }
  }

  /**
   * Get the active sync run for an account (if any).
   */
  async getActiveSyncRun(
    accountId: string
  ): Promise<{ accountId: string; runStartedAt: Date } | null> {
    const result = await this.query(
      `SELECT "_account_id", started_at FROM "${this.config.schema}"."_sync_run"
       WHERE "_account_id" = $1 AND status = 'running'`,
      [accountId]
    )

    if (result.rows.length === 0) return null
    const row = result.rows[0]
    return { accountId: row._account_id, runStartedAt: row.started_at }
  }

  /**
   * Get full sync run details.
   */
  async getSyncRun(
    accountId: string,
    runStartedAt: Date
  ): Promise<{
    accountId: string
    runStartedAt: Date
    status: string
    maxConcurrent: number
  } | null> {
    const result = await this.query(
      `SELECT "_account_id", started_at, status, max_concurrent
       FROM "${this.config.schema}"."_sync_run"
       WHERE "_account_id" = $1 AND started_at = $2`,
      [accountId, runStartedAt]
    )

    if (result.rows.length === 0) return null
    const row = result.rows[0]
    return {
      accountId: row._account_id,
      runStartedAt: row.started_at,
      status: row.status,
      maxConcurrent: row.max_concurrent,
    }
  }

  /**
   * Mark a sync run as complete.
   */
  async completeSyncRun(accountId: string, runStartedAt: Date): Promise<void> {
    await this.query(
      `UPDATE "${this.config.schema}"."_sync_run"
       SET status = 'complete', completed_at = now()
       WHERE "_account_id" = $1 AND started_at = $2`,
      [accountId, runStartedAt]
    )
  }

  /**
   * Mark a sync run as failed.
   */
  async failSyncRun(accountId: string, runStartedAt: Date, errorMessage: string): Promise<void> {
    await this.query(
      `UPDATE "${this.config.schema}"."_sync_run"
       SET status = 'error', error_message = $3, completed_at = now()
       WHERE "_account_id" = $1 AND started_at = $2`,
      [accountId, runStartedAt, errorMessage]
    )
  }

  /**
   * Create object run entries for a sync run.
   * All objects start as 'pending'.
   */
  async createObjectRuns(accountId: string, runStartedAt: Date, objects: string[]): Promise<void> {
    if (objects.length === 0) return

    const values = objects.map((_, i) => `($1, $2, $${i + 3})`).join(', ')
    await this.query(
      `INSERT INTO "${this.config.schema}"."_sync_obj_run" ("_account_id", run_started_at, object)
       VALUES ${values}
       ON CONFLICT ("_account_id", run_started_at, object) DO NOTHING`,
      [accountId, runStartedAt, ...objects]
    )
  }

  /**
   * Try to start an object sync (respects max_concurrent).
   * Returns true if claimed, false if already running or at concurrency limit.
   *
   * Note: There's a small race window where concurrent calls could result in
   * max_concurrent + 1 objects running. This is acceptable behavior.
   */
  async tryStartObjectSync(
    accountId: string,
    runStartedAt: Date,
    object: string
  ): Promise<boolean> {
    // 1. Check object concurrency limit
    const run = await this.getSyncRun(accountId, runStartedAt)
    if (!run) return false

    const runningCount = await this.countRunningObjects(accountId, runStartedAt)
    if (runningCount >= run.maxConcurrent) return false

    // 2. Try to claim this object (atomic)
    const result = await this.query(
      `UPDATE "${this.config.schema}"."_sync_obj_run"
       SET status = 'running', started_at = now(), updated_at = now()
       WHERE "_account_id" = $1 AND run_started_at = $2 AND object = $3 AND status = 'pending'
       RETURNING *`,
      [accountId, runStartedAt, object]
    )

    return (result.rowCount ?? 0) > 0
  }

  /**
   * Get object run details.
   */
  async getObjectRun(
    accountId: string,
    runStartedAt: Date,
    object: string
  ): Promise<{
    object: string
    status: string
    processedCount: number
    cursor: string | null
  } | null> {
    const result = await this.query(
      `SELECT object, status, processed_count, cursor
       FROM "${this.config.schema}"."_sync_obj_run"
       WHERE "_account_id" = $1 AND run_started_at = $2 AND object = $3`,
      [accountId, runStartedAt, object]
    )

    if (result.rows.length === 0) return null
    const row = result.rows[0]
    return {
      object: row.object,
      status: row.status,
      processedCount: row.processed_count,
      cursor: row.cursor,
    }
  }

  /**
   * Update progress for an object sync.
   * Also touches updated_at for stale detection.
   */
  async incrementObjectProgress(
    accountId: string,
    runStartedAt: Date,
    object: string,
    count: number
  ): Promise<void> {
    await this.query(
      `UPDATE "${this.config.schema}"."_sync_obj_run"
       SET processed_count = processed_count + $4, updated_at = now()
       WHERE "_account_id" = $1 AND run_started_at = $2 AND object = $3`,
      [accountId, runStartedAt, object, count]
    )
  }

  /**
   * Update the cursor for an object sync.
   * Only updates if the new cursor is higher than the existing one (cursors should never decrease).
   * For numeric cursors (timestamps), uses GREATEST to ensure monotonic increase.
   * For non-numeric cursors, just sets the value directly.
   */
  async updateObjectCursor(
    accountId: string,
    runStartedAt: Date,
    object: string,
    cursor: string | null
  ): Promise<void> {
    // Check if cursor is numeric (for incremental sync timestamps)
    const isNumeric = cursor !== null && /^\d+$/.test(cursor)
    if (isNumeric) {
      await this.query(
        `UPDATE "${this.config.schema}"."_sync_obj_run"
         SET cursor = GREATEST(COALESCE(cursor::bigint, 0), $4::bigint)::text,
             updated_at = now()
         WHERE "_account_id" = $1 AND run_started_at = $2 AND object = $3`,
        [accountId, runStartedAt, object, cursor]
      )
    } else {
      await this.query(
        `UPDATE "${this.config.schema}"."_sync_obj_run"
         SET cursor = $4, updated_at = now()
         WHERE "_account_id" = $1 AND run_started_at = $2 AND object = $3`,
        [accountId, runStartedAt, object, cursor]
      )
    }
  }

  /**
   * Get the highest cursor from previous syncs for an object type.
   * This considers completed, error, AND running runs to ensure recovery syncs
   * don't re-process data that was already synced before a crash.
   * A 'running' status with a cursor means the process was killed mid-sync.
   */
  async getLastCompletedCursor(accountId: string, object: string): Promise<string | null> {
    const result = await this.query(
      `SELECT MAX(o.cursor::bigint)::text as cursor
       FROM "${this.config.schema}"."_sync_obj_run" o
       WHERE o."_account_id" = $1
         AND o.object = $2
         AND o.cursor IS NOT NULL`,
      [accountId, object]
    )
    return result.rows[0]?.cursor ?? null
  }

  /**
   * Delete all sync runs and object runs for an account.
   * Useful for testing or resetting sync state.
   */
  async deleteSyncRuns(accountId: string): Promise<void> {
    // Delete object runs first (foreign key constraint)
    await this.query(
      `DELETE FROM "${this.config.schema}"."_sync_obj_run" WHERE "_account_id" = $1`,
      [accountId]
    )
    await this.query(`DELETE FROM "${this.config.schema}"."_sync_run" WHERE "_account_id" = $1`, [
      accountId,
    ])
  }

  /**
   * Mark an object sync as complete.
   */
  async completeObjectSync(accountId: string, runStartedAt: Date, object: string): Promise<void> {
    await this.query(
      `UPDATE "${this.config.schema}"."_sync_obj_run"
       SET status = 'complete', completed_at = now()
       WHERE "_account_id" = $1 AND run_started_at = $2 AND object = $3`,
      [accountId, runStartedAt, object]
    )
  }

  /**
   * Mark an object sync as failed.
   */
  async failObjectSync(
    accountId: string,
    runStartedAt: Date,
    object: string,
    errorMessage: string
  ): Promise<void> {
    await this.query(
      `UPDATE "${this.config.schema}"."_sync_obj_run"
       SET status = 'error', error_message = $4, completed_at = now()
       WHERE "_account_id" = $1 AND run_started_at = $2 AND object = $3`,
      [accountId, runStartedAt, object, errorMessage]
    )
  }

  /**
   * Count running objects in a run.
   */
  async countRunningObjects(accountId: string, runStartedAt: Date): Promise<number> {
    const result = await this.query(
      `SELECT COUNT(*) as count FROM "${this.config.schema}"."_sync_obj_run"
       WHERE "_account_id" = $1 AND run_started_at = $2 AND status = 'running'`,
      [accountId, runStartedAt]
    )
    return parseInt(result.rows[0].count)
  }

  /**
   * Get the next pending object to process.
   * Returns null if no pending objects or at concurrency limit.
   */
  async getNextPendingObject(accountId: string, runStartedAt: Date): Promise<string | null> {
    // Check concurrency limit first
    const run = await this.getSyncRun(accountId, runStartedAt)
    if (!run) return null

    const runningCount = await this.countRunningObjects(accountId, runStartedAt)
    if (runningCount >= run.maxConcurrent) return null

    const result = await this.query(
      `SELECT object FROM "${this.config.schema}"."_sync_obj_run"
       WHERE "_account_id" = $1 AND run_started_at = $2 AND status = 'pending'
       ORDER BY object
       LIMIT 1`,
      [accountId, runStartedAt]
    )

    return result.rows.length > 0 ? result.rows[0].object : null
  }

  /**
   * Check if all objects in a run are complete (or error).
   */
  async areAllObjectsComplete(accountId: string, runStartedAt: Date): Promise<boolean> {
    const result = await this.query(
      `SELECT COUNT(*) as count FROM "${this.config.schema}"."_sync_obj_run"
       WHERE "_account_id" = $1 AND run_started_at = $2 AND status IN ('pending', 'running')`,
      [accountId, runStartedAt]
    )
    return parseInt(result.rows[0].count) === 0
  }
}
