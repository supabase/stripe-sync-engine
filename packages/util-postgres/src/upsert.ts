import type pg from 'pg'
import { ident, identList, qualifiedTable } from './sql.js'

export type UpsertOptions = {
  schema?: string
  table: string
  /** ON CONFLICT target columns. */
  keyColumns: string[]
  /** JSONB columns that get shallow-merged: COALESCE(tbl.col, '{}'::jsonb) || EXCLUDED.col */
  shallowMergeJsonbColumns?: string[]
  /** Columns excluded from IS DISTINCT FROM check (still updated). */
  noDiffColumns?: string[]
  /** Columns set on INSERT only — never overwritten on conflict. */
  insertOnlyColumns?: string[]
  /** Guard columns: update only proceeds if these match EXCLUDED values. */
  mustMatchColumns?: string[]
  /** Skip no-op updates via IS DISTINCT FROM (default: true). */
  skipNoopUpdates?: boolean
  /** Append RETURNING * (default: false). */
  returning?: boolean
}

function isJsonbValue(v: unknown): boolean {
  return v !== null && typeof v === 'object'
}

function paramPlaceholder(index: number, value: unknown): string {
  return isJsonbValue(value) ? `$${index}::jsonb` : `$${index}`
}

function serializeValue(v: unknown): unknown {
  return isJsonbValue(v) ? JSON.stringify(v) : v
}

/**
 * Pure SQL builder — returns the parameterised INSERT ... ON CONFLICT statement
 * and the flattened parameter array.
 */
export function buildUpsertSql(
  records: Record<string, unknown>[],
  options: UpsertOptions
): { sql: string; params: unknown[] } {
  if (records.length === 0) {
    throw new Error('buildUpsertSql requires at least one record')
  }

  const {
    schema,
    table,
    keyColumns,
    shallowMergeJsonbColumns = [],
    noDiffColumns = [],
    insertOnlyColumns = [],
    mustMatchColumns = [],
    skipNoopUpdates = true,
    returning = false,
  } = options

  // Derive column list from the first record — all records must have the same shape.
  const columns = Object.keys(records[0]!)
  const tbl = qualifiedTable(schema, table)
  const shallowMergeSet = new Set(shallowMergeJsonbColumns)
  const insertOnlySet = new Set(insertOnlyColumns)
  const noDiffSet = new Set(noDiffColumns)
  const keySet = new Set(keyColumns)

  // --- VALUES rows -----------------------------------------------------------
  const params: unknown[] = []
  const valueRows: string[] = []
  for (const rec of records) {
    const placeholders: string[] = []
    for (const col of columns) {
      const v = rec[col]
      params.push(serializeValue(v))
      placeholders.push(paramPlaceholder(params.length, v))
    }
    valueRows.push(`(${placeholders.join(', ')})`)
  }

  // --- SET clause (columns to update on conflict) ----------------------------
  const updateCols = columns.filter((c) => !keySet.has(c) && !insertOnlySet.has(c))

  const setClauses = updateCols.map((col) => {
    if (shallowMergeSet.has(col)) {
      return `${ident(col)} = COALESCE(${ident(table)}.${ident(col)}, '{}'::jsonb) || EXCLUDED.${ident(col)}`
    }
    return `${ident(col)} = EXCLUDED.${ident(col)}`
  })

  // --- WHERE clause ----------------------------------------------------------
  const whereParts: string[] = []

  if (skipNoopUpdates) {
    const diffCols = updateCols.filter((c) => !noDiffSet.has(c))
    if (diffCols.length > 0) {
      const distinctParts = diffCols.map(
        (col) => `${ident(table)}.${ident(col)} IS DISTINCT FROM EXCLUDED.${ident(col)}`
      )
      whereParts.push(`(${distinctParts.join(' OR ')})`)
    }
  }

  for (const col of mustMatchColumns) {
    whereParts.push(`${ident(table)}.${ident(col)} = EXCLUDED.${ident(col)}`)
  }

  // --- Assemble --------------------------------------------------------------
  let sql = `INSERT INTO ${tbl} (${identList(columns)})\nVALUES ${valueRows.join(',\n       ')}\nON CONFLICT (${identList(keyColumns)})`

  if (setClauses.length > 0) {
    sql += `\nDO UPDATE SET ${setClauses.join(',\n              ')}`
    if (whereParts.length > 0) {
      sql += `\nWHERE ${whereParts.join('\n  AND ')}`
    }
  } else {
    sql += '\nDO NOTHING'
  }

  if (returning) {
    sql += '\nRETURNING *'
  }

  return { sql, params }
}

/**
 * Execute an upsert against a Postgres client/pool.
 *
 * `client` can be a `pg.Pool`, `pg.PoolClient`, or `pg.Client` — anything with
 * a compatible `.query()` method.
 */
export async function upsert(
  client: { query(text: string, values?: unknown[]): Promise<pg.QueryResult> },
  records: Record<string, unknown>[],
  options: UpsertOptions
): Promise<pg.QueryResult> {
  const { sql, params } = buildUpsertSql(records, options)
  return client.query(sql, params)
}
