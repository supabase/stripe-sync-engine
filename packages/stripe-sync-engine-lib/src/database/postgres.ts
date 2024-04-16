import pg from 'pg'
import { pg as sql } from 'yesql'
import { JsonSchema } from '../types/types'

type PostgresConfig = {
  databaseUrl: string
  schema: string
}

export class PostgresClient {
  pool: pg.Pool

  constructor(private config: PostgresConfig) {
    this.pool = new pg.Pool({ connectionString: config.databaseUrl })
  }

  async upsertMany<
    T extends {
      [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  >(entries: T[], table: string, tableSchema: JsonSchema): Promise<T[]> {
    const queries: Promise<pg.QueryResult<T>>[] = []

    entries.forEach((entry) => {
      // Inject the values
      const cleansed = this.cleanseArrayField(entry, tableSchema)
      const upsertSql = this.constructUpsertSql(this.config.schema, table, tableSchema)

      const prepared = sql(upsertSql, {
        useNullForMissing: true,
      })(cleansed)

      queries.push(this.pool.query(prepared.text, prepared.values))
    })

    // Run it
    const results = await Promise.all(queries)

    return results.flatMap((it) => it.rows)
  }

  private constructUpsertSql = (schema: string, table: string, tableSchema: JsonSchema): string => {
    const conflict = 'id'
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

  query = (text: string, params?: string[]): Promise<pg.QueryResult> => {
    return this.pool.query(text, params)
  }

  findMissingEntries = async (table: string, ids: string[]): Promise<string[]> => {
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

  deleteOne = async (table: string, id: string): Promise<boolean> => {
    const prepared = sql(`
    delete from "${this.config.schema}"."${table}"
    where id = :id
    returning id;
    `)({ id })
    const { rows } = await this.query(prepared.text, prepared.values)
    return rows.length > 0
  }

  private cleanseArrayField(
    obj: {
      [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
    },
    tableSchema: JsonSchema
  ): {
    [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
  } {
    const cleansed = { ...obj }
    Object.keys(cleansed).map((k) => {
      const definition = tableSchema.properties[k]
      if (definition && (definition as { type: string }).type === 'array') return
      const data = cleansed[k]
      if (Array.isArray(data)) {
        cleansed[k] = JSON.stringify(data)
      }
    })
    return cleansed
  }
}
