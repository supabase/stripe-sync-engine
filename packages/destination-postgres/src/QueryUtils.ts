export type InsertColumn = { column: string; pgType: string; value: unknown }

export class QueryUtils {
  private constructor() {
    /* prevent instantiation */
  }

  static quoteIdent(name: string): string {
    return `"${name}"`
  }

  static quotedList(names: string[]): string {
    return names.map(QueryUtils.quoteIdent).join(', ')
  }

  static buildInsertParts(columns: InsertColumn[]): {
    columnsSql: string
    valuesSql: string
    params: unknown[]
  } {
    const columnsSql = columns.map((c) => QueryUtils.quoteIdent(c.column)).join(', ')
    const valuesSql = columns
      .map((c, i) => {
        const placeholder = `$${i + 1}`
        // jsonb requires explicit cast; other types benefit from explicit casts too
        return `${placeholder}::${c.pgType}`
      })
      .join(', ')
    const params = columns.map((c) => c.value)
    return { columnsSql, valuesSql, params }
  }

  static buildRawJsonUpsertQuery(
    schema: string,
    table: string,
    columns: InsertColumn[],
    conflictTarget: string[],
    extraColumns?: string[]
  ): { sql: string; params: unknown[] } {
    const { columnsSql, valuesSql, params } = QueryUtils.buildInsertParts(columns)
    const conflictSql = QueryUtils.quotedList(conflictTarget)

    // Find the _last_synced_at param index for the WHERE clause
    const tsParamIdx = columns.findIndex((c) => c.column === '_last_synced_at') + 1
    if (tsParamIdx <= 0) {
      throw new Error('buildRawJsonUpsertQuery requires _last_synced_at column')
    }

    // Build the SET clause for extra columns (update them on conflict)
    const extraSetClauses = (extraColumns ?? [])
      .map((col) => `${QueryUtils.quoteIdent(col)} = EXCLUDED.${QueryUtils.quoteIdent(col)}`)
      .join(',\n      ')

    const sql = `
    INSERT INTO ${QueryUtils.quoteIdent(schema)}.${QueryUtils.quoteIdent(table)} (${columnsSql})
    VALUES (${valuesSql})
    ON CONFLICT (${conflictSql})
    DO UPDATE SET
      "_raw_data" = EXCLUDED."_raw_data",
      "_last_synced_at" = $${tsParamIdx},
      "_account_id" = EXCLUDED."_account_id"${extraSetClauses ? ',\n      ' + extraSetClauses : ''}
    WHERE ${QueryUtils.quoteIdent(table)}."_last_synced_at" IS NULL
       OR ${QueryUtils.quoteIdent(table)}."_last_synced_at" < $${tsParamIdx}
    RETURNING *
  `

    return { sql, params }
  }
}
