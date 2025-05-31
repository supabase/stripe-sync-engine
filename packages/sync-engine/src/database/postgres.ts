import pg, { QueryResult } from 'pg'
import { pg as sql } from 'yesql'
import { JsonSchema } from '../schemas/types'

type PostgresConfig = {
  databaseUrl: string
  schema: string
  maxConnections?: number
}

export class PostgresClient {
  pool: pg.Pool

  constructor(private config: PostgresConfig) {
    this.pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.maxConnections || 10,
      keepAlive: true,
    })
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
  >(entries: T[], table: string, tableSchema: JsonSchema): Promise<T[]> {
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
    tableSchema: JsonSchema,
    options?: {
      conflict?: string
    }
  ): string {
    const { conflict = 'id' } = options || {}
    const properties = tableSchema.properties

    return `
    insert into "${schema}"."${table}" (
      ${Object.keys(properties)
        .map((x) => `"${x}"`)
        .join(',')}
    )
    values (
      ${Object.keys(properties)
        .map((x) => `:${x}`)
        .join(',')}
    )
    on conflict (
      ${conflict}
    )
    do update set 
      ${Object.keys(properties)
        .map((x) => `"${x}" = :${x}`)
        .join(',')}
    ;`
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
