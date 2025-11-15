import pg, { PoolConfig, QueryResult } from 'pg'
import { pg as sql } from 'yesql'

type PostgresConfig = {
  schema: string
  poolConfig: PoolConfig
}

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

  async query(text: string, params?: string[]): Promise<QueryResult> {
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

  async getSyncCursor(resource: string): Promise<number | null> {
    const result = await this.query(
      `SELECT EXTRACT(EPOCH FROM last_incremental_cursor)::integer as cursor
       FROM "${this.config.schema}"."_sync_status"
       WHERE resource = $1`,
      [resource]
    )
    const cursor = result.rows[0]?.cursor ?? null
    return cursor
  }

  async updateSyncCursor(resource: string, cursor: number): Promise<void> {
    // Only update if the new cursor is greater than the existing one
    // This handles Stripe returning results in descending order (newest first)
    // Convert Unix timestamp to timestamptz for human-readable storage
    await this.query(
      `INSERT INTO "${this.config.schema}"."_sync_status" (resource, last_incremental_cursor, status, last_synced_at)
       VALUES ($1, to_timestamp($2), 'running', now())
       ON CONFLICT (resource)
       DO UPDATE SET
         last_incremental_cursor = GREATEST(
           COALESCE("${this.config.schema}"."_sync_status".last_incremental_cursor, to_timestamp(0)),
           to_timestamp($2)
         ),
         last_synced_at = now(),
         updated_at = now()`,
      [resource, cursor.toString()]
    )
  }

  async markSyncRunning(resource: string): Promise<void> {
    await this.query(
      `INSERT INTO "${this.config.schema}"."_sync_status" (resource, status)
       VALUES ($1, 'running')
       ON CONFLICT (resource)
       DO UPDATE SET status = 'running', updated_at = now()`,
      [resource]
    )
  }

  async markSyncComplete(resource: string): Promise<void> {
    await this.query(
      `UPDATE "${this.config.schema}"."_sync_status"
       SET status = 'complete', error_message = NULL, updated_at = now()
       WHERE resource = $1`,
      [resource]
    )
  }

  async markSyncError(resource: string, errorMessage: string): Promise<void> {
    await this.query(
      `UPDATE "${this.config.schema}"."_sync_status"
       SET status = 'error', error_message = $2, updated_at = now()
       WHERE resource = $1`,
      [resource, errorMessage]
    )
  }
}
