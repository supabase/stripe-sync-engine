import pg, { PoolConfig, QueryResult } from 'pg'
import { pg as sql } from 'yesql'

type PostgresConfig = {
  schema: string
  poolConfig: PoolConfig
}

// All Stripe tables that store account-related data.
// Ordered for safe cascade deletion: dependencies first, then accounts last.
// Note: 'customers' is near the end because other tables reference it.
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
  '_sync_status',
] as const

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
        // Extract id and store entire entry as raw_data jsonb
        const id = entry.id
        const rawData = JSON.stringify(entry)

        // Use explicit parameter placeholders to avoid yesql parsing issues with ::jsonb cast
        const upsertSql = `
          INSERT INTO "${this.config.schema}"."${table}" ("id", "raw_data")
          VALUES ($1, $2::jsonb)
          ON CONFLICT ("id")
          DO UPDATE SET
            "raw_data" = EXCLUDED."raw_data"
          RETURNING *
        `

        queries.push(this.pool.query(upsertSql, [id, rawData]))
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
            (k) => k !== 'last_synced_at' && k !== '_account_id'
          )

          const upsertSql = `
            INSERT INTO "${this.config.schema}"."${table}" (
              ${columns.map((c) => `"${c}"`).join(', ')}, "last_synced_at", "_account_id"
            )
            VALUES (
              ${columns.map((c) => `:${c}`).join(', ')}, :last_synced_at, :_account_id
            )
            ON CONFLICT ("id")
            DO UPDATE SET
              ${columns.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')},
              "last_synced_at" = :last_synced_at,
              "_account_id" = EXCLUDED."_account_id"
            WHERE "${table}"."last_synced_at" IS NULL
               OR "${table}"."last_synced_at" < :last_synced_at
            RETURNING *
          `

          const cleansed = this.cleanseArrayField(entry)
          cleansed.last_synced_at = timestamp
          cleansed._account_id = accountId
          const prepared = sql(upsertSql, { useNullForMissing: true })(cleansed)
          queries.push(this.pool.query(prepared.text, prepared.values))
        } else {
          // Extract id and store entire entry as raw_data jsonb
          const id = entry.id
          const rawData = JSON.stringify(entry)

          // Use explicit parameter placeholders to avoid yesql parsing issues with ::jsonb cast
          const upsertSql = `
            INSERT INTO "${this.config.schema}"."${table}" ("id", "raw_data", "last_synced_at", "_account_id")
            VALUES ($1, $2::jsonb, $3, $4)
            ON CONFLICT ("id")
            DO UPDATE SET
              "raw_data" = EXCLUDED."raw_data",
              "last_synced_at" = $3,
              "_account_id" = EXCLUDED."_account_id"
            WHERE "${table}"."last_synced_at" IS NULL
               OR "${table}"."last_synced_at" < $3
            RETURNING *
          `

          queries.push(this.pool.query(upsertSql, [id, rawData, timestamp, accountId]))
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

  // Sync status tracking methods for incremental backfill

  async getSyncCursor(resource: string, accountId: string): Promise<number | null> {
    const result = await this.query(
      `SELECT EXTRACT(EPOCH FROM last_incremental_cursor)::integer as cursor
       FROM "${this.config.schema}"."_sync_status"
       WHERE resource = $1 AND "_account_id" = $2`,
      [resource, accountId]
    )
    const cursor = result.rows[0]?.cursor ?? null
    return cursor
  }

  async updateSyncCursor(resource: string, accountId: string, cursor: number): Promise<void> {
    // Only update if the new cursor is greater than the existing one
    // This handles Stripe returning results in descending order (newest first)
    // Convert Unix timestamp to timestamptz for human-readable storage
    await this.query(
      `INSERT INTO "${this.config.schema}"."_sync_status" (resource, "_account_id", last_incremental_cursor, status, last_synced_at)
       VALUES ($1, $2, to_timestamp($3), 'running', now())
       ON CONFLICT (resource, "_account_id")
       DO UPDATE SET
         last_incremental_cursor = GREATEST(
           COALESCE("${this.config.schema}"."_sync_status".last_incremental_cursor, to_timestamp(0)),
           to_timestamp($3)
         ),
         last_synced_at = now(),
         updated_at = now()`,
      [resource, accountId, cursor.toString()]
    )
  }

  async markSyncRunning(resource: string, accountId: string): Promise<void> {
    await this.query(
      `INSERT INTO "${this.config.schema}"."_sync_status" (resource, "_account_id", status)
       VALUES ($1, $2, 'running')
       ON CONFLICT (resource, "_account_id")
       DO UPDATE SET status = 'running', updated_at = now()`,
      [resource, accountId]
    )
  }

  async markSyncComplete(resource: string, accountId: string): Promise<void> {
    await this.query(
      `UPDATE "${this.config.schema}"."_sync_status"
       SET status = 'complete', error_message = NULL, updated_at = now()
       WHERE resource = $1 AND "_account_id" = $2`,
      [resource, accountId]
    )
  }

  async markSyncError(resource: string, accountId: string, errorMessage: string): Promise<void> {
    await this.query(
      `UPDATE "${this.config.schema}"."_sync_status"
       SET status = 'error', error_message = $3, updated_at = now()
       WHERE resource = $1 AND "_account_id" = $2`,
      [resource, accountId, errorMessage]
    )
  }

  // Account management methods

  async upsertAccount(accountData: {
    id: string
    raw_data: any // eslint-disable-line @typescript-eslint/no-explicit-any
  }): Promise<void> {
    const rawData = JSON.stringify(accountData.raw_data)

    await this.query(
      `INSERT INTO "${this.config.schema}"."accounts" ("id", "raw_data", "first_synced_at", "last_synced_at")
       VALUES ($1, $2::jsonb, now(), now())
       ON CONFLICT ("id")
       DO UPDATE SET
         "raw_data" = EXCLUDED."raw_data",
         "last_synced_at" = now(),
         "updated_at" = now()`,
      [accountData.id, rawData]
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAllAccounts(): Promise<any[]> {
    const result = await this.query(
      `SELECT raw_data FROM "${this.config.schema}"."accounts"
       ORDER BY last_synced_at DESC`
    )
    return result.rows.map((row) => row.raw_data)
  }

  async getAccountRecordCounts(accountId: string): Promise<{ [tableName: string]: number }> {
    const counts: { [tableName: string]: number } = {}

    for (const table of ORDERED_STRIPE_TABLES) {
      const result = await this.query(
        `SELECT COUNT(*) as count FROM "${this.config.schema}"."${table}"
         WHERE "_account_id" = $1`,
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
        const result = await this.query(
          `DELETE FROM "${this.config.schema}"."${table}"
           WHERE "_account_id" = $1`,
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
}
