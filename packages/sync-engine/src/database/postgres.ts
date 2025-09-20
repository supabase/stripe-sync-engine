import pg, { PoolConfig, QueryResult } from 'pg'
import { pg as sql } from 'yesql'
import { EntitySchema } from '../schemas/types'

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
  >(entries: T[], table: string, tableSchema: EntitySchema): Promise<T[]> {
    if (!entries.length) return []

    // Max 5 in parallel to avoid exhausting connection pool
    const chunkSize = 5
    const results: pg.QueryResult<T>[] = []

    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize)

      const queries: Promise<pg.QueryResult<T>>[] = []
      chunk.forEach((entry) => {
        // Inject the values
        const cleansed = this.cleanseArrayField(entry)
        const upsertSql = this.constructUpsertSql(this.config.schema, table, tableSchema)

        const prepared = sql(upsertSql, {
          useNullForMissing: true,
        })(cleansed)

        queries.push(this.pool.query(prepared.text, prepared.values))
      })

      results.push(...(await Promise.all(queries)))
    }

    return results.flatMap((it) => it.rows)
  }

  async upsertManyWithTimestampProtection<
    T extends {
      [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  >(entries: T[], table: string, tableSchema: EntitySchema, syncTimestamp?: string): Promise<T[]> {
    const timestamp = syncTimestamp || new Date().toISOString()

    if (!entries.length) return []

    // Max 5 in parallel to avoid exhausting connection pool
    const chunkSize = 5
    const results: pg.QueryResult<T>[] = []

    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize)

      const queries: Promise<pg.QueryResult<T>>[] = []
      chunk.forEach((entry) => {
        // Inject the values
        const cleansed = this.cleanseArrayField(entry)
        // Add last_synced_at to the cleansed data for SQL parameter binding
        cleansed.last_synced_at = timestamp

        const upsertSql = this.constructUpsertWithTimestampProtectionSql(
          this.config.schema,
          table,
          tableSchema
        )

        const prepared = sql(upsertSql, {
          useNullForMissing: true,
        })(cleansed)

        queries.push(this.pool.query(prepared.text, prepared.values))
      })

      results.push(...(await Promise.all(queries)))
    }

    return results.flatMap((it) => it.rows)
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

  /**
   * Returns an (yesql formatted) upsert function based on the key/vals of an object.
   * eg,
   *  insert into customers ("id", "name")
   *  values (:id, :name)
   *  on conflict (id)
   *  do update set (
   *   "id" = :id,
   *   "name" = :name
   *  )
   */
  private constructUpsertSql(
    schema: string,
    table: string,
    tableSchema: EntitySchema,
    options?: {
      conflict?: string
    }
  ): string {
    const { conflict = 'id' } = options || {}
    const properties = tableSchema.properties

    return `
    insert into "${schema}"."${table}" (
      ${properties.map((x) => `"${x}"`).join(',')}
    )
    values (
      ${properties.map((x) => `:${x}`).join(',')}
    )
    on conflict (
      ${conflict}
    )
    do update set 
      ${properties.map((x) => `"${x}" = :${x}`).join(',')}
    ;`
  }

  /**
   * Returns an (yesql formatted) upsert function with timestamp protection.
   *
   * The WHERE clause in ON CONFLICT DO UPDATE only applies to the conflicting row
   * (the row being updated), not to all rows in the table. PostgreSQL ensures that
   * the condition is evaluated only for the specific row that conflicts with the INSERT.
   *
   *
   * eg:
   *   INSERT INTO "stripe"."charges" (
   *     "id", "amount", "created", "last_synced_at"
   *   )
   *   VALUES (
   *     :id, :amount, :created, :last_synced_at
   *   )
   *   ON CONFLICT (id) DO UPDATE SET
   *     "amount" = EXCLUDED."amount",
   *     "created" = EXCLUDED."created",
   *     last_synced_at = :last_synced_at
   *   WHERE "charges"."last_synced_at" IS NULL
   *      OR "charges"."last_synced_at" < :last_synced_at;
   */
  private constructUpsertWithTimestampProtectionSql = (
    schema: string,
    table: string,
    tableSchema: EntitySchema
  ): string => {
    const conflict = 'id'
    const properties = tableSchema.properties

    return `
      INSERT INTO "${schema}"."${table}" (
        ${properties.map((x) => `"${x}"`).join(',')}, "last_synced_at"
      )
      VALUES (
        ${properties.map((x) => `:${x}`).join(',')}, :last_synced_at
      )
      ON CONFLICT (${conflict}) DO UPDATE SET
        ${properties
          .filter((x) => x !== 'last_synced_at')
          .map((x) => `"${x}" = EXCLUDED."${x}"`)
          .join(',')},
        last_synced_at = :last_synced_at
      WHERE "${table}"."last_synced_at" IS NULL 
         OR "${table}"."last_synced_at" < :last_synced_at;`
  }

  /**
   * For array object field like invoice.custom_fields
   * ex: [{"name":"Project name","value":"Test Project"}]
   *
   * we need to stringify it first cos passing array object directly will end up with
   * {
   * invalid input syntax for type json
   * detail: 'Expected ":", but found "}".',
   * where: 'JSON data, line 1: ...\\":\\"Project name\\",\\"value\\":\\"Test Project\\"}"}',
   * }
   */

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
}
