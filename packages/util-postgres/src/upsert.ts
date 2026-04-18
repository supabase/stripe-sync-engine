import type pg from 'pg'
import { ident, identList, qualifiedTable } from './sql.js'

export type UpsertOptions = {
  schema?: string
  table: string

  /** ON CONFLICT target columns — the unique constraint used to detect existing rows. */
  keyColumns: string[]

  /**
   * JSONB columns that get shallow-merged instead of replaced.
   * SQL: `col = COALESCE(tbl.col, '{}'::jsonb) || EXCLUDED.col`
   *
   * Example: A `metadata` column where each sync adds keys without clobbering
   * existing ones. Source A writes `{"source": "stripe"}`, source B writes
   * `{"tier": "premium"}` — the result is `{"source": "stripe", "tier": "premium"}`.
   */
  shallowMergeJsonbColumns?: string[]

  /**
   * Columns excluded from the IS DISTINCT FROM no-op check, but still updated.
   * Use for columns that change every write but shouldn't prevent the update
   * from being skipped as a no-op.
   *
   * Example: A `synced_at` timestamp set to `now()` on every upsert. Without
   * this option, every row would appear "changed" due to `synced_at` differing,
   * defeating `skipNoopUpdates`.
   */
  volatileColumns?: string[]

  /**
   * Columns written on INSERT only — never overwritten on conflict.
   *
   * Example: A `first_seen_at` timestamp that records when the row was first
   * created. On subsequent upserts the value is preserved regardless of what
   * the incoming record contains.
   */
  insertOnlyColumns?: string[]

  /**
   * Guard columns: the update only proceeds if the existing row's value for
   * these columns matches the incoming EXCLUDED value.
   * SQL: `WHERE tbl.col = EXCLUDED.col`
   *
   * Example: Multi-tenant table with a `account_id` column. Ensures an upsert
   * cannot accidentally overwrite a row belonging to a different account, even
   * if the primary key collides.
   */
  guardColumns?: string[]

  /**
   * Only update if the incoming row is newer than the existing row, based on
   * this column. SQL: `WHERE EXCLUDED.col > tbl.col`
   *
   * Example: Stripe webhook events arriving out of order. Using `updated` as
   * the newerThanColumn ensures a stale event (lower `updated` timestamp)
   * cannot overwrite a row that was already updated by a more recent event.
   */
  newerThanColumn?: string

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
    volatileColumns = [],
    insertOnlyColumns = [],
    guardColumns = [],
    newerThanColumn,
    skipNoopUpdates = true,
    returning = false,
  } = options

  // Derive column list from the first record — all records must have the same shape.
  const columns = Object.keys(records[0]!)
  const tbl = qualifiedTable(schema, table)
  const shallowMergeSet = new Set(shallowMergeJsonbColumns)
  const insertOnlySet = new Set(insertOnlyColumns)
  const noDiffSet = new Set(volatileColumns)
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

  for (const col of guardColumns) {
    whereParts.push(`${ident(table)}.${ident(col)} = EXCLUDED.${ident(col)}`)
  }

  if (newerThanColumn) {
    whereParts.push(
      `EXCLUDED.${ident(newerThanColumn)} > ${ident(table)}.${ident(newerThanColumn)}`
    )
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
