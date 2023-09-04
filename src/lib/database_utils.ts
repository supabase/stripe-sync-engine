import { QueryResult } from 'pg'
import { cleanseArrayField } from '../utils/helpers'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'

const config = getConfig()

export const upsertMany = async <
  T extends {
    [Key: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
  },
>(
  entries: T[],
  upsertSql: (entry: T) => string
): Promise<T[]> => {
  const queries: Promise<QueryResult<T>>[] = []

  entries.forEach((entry) => {
    // Inject the values
    const cleansed = cleanseArrayField(entry)
    const prepared = sql(upsertSql(entry), { useNullForMissing: true })(cleansed)

    queries.push(query(prepared.text, prepared.values))
  })

  // Run it
  const results = await Promise.all(queries)

  return results.flatMap((it) => it.rows)
}

export const findMissingEntries = async (table: string, ids: string[]): Promise<string[]> => {
  if (!ids.length) return []

  const prepared = sql(`
    select id from "${config.SCHEMA}"."${table}"
    where id=any(:ids::text[]);
    `)({ ids })

  const { rows } = await query(prepared.text, prepared.values)
  const existingIds = rows.map((it) => it.id)

  const missingIds = ids.filter((it) => !existingIds.includes(it))

  return missingIds
}

export const getUniqueIds = <T>(entries: T[], key: keyof T): string[] => {
  const set = new Set(
    entries
      .map((subscription) => subscription?.[key]?.toString())
      .filter((it): it is string => Boolean(it))
  )

  return Array.from(set)
}
