import type pg from 'pg'
import { ident, identList, qualifiedTable } from './sql.js'

export type UpsertOptions = {
  /**
   * Postgres schema name (e.g. `public`, `stripe`). Omit for the default search_path.
   *
   * Example: Multi-tenant setup where each account's data lives in a separate
   * schema — pass `schema: accountId` to write to the correct namespace.
   */
  schema?: string

  /**
   * Target table name.
   *
   * Example: `"customers"` for a table storing Stripe customer objects.
   */
  table: string

  /**
   * ON CONFLICT target columns — the unique constraint used to detect existing rows.
   *
   * Example: `["id"]` for a Stripe resource table keyed on the object ID.
   * For a composite key: `["account_id", "item_id"]`.
   */
  primaryKeyColumns: string[]

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
   * these columns matches the incoming value.
   * SQL: `WHERE tbl.col = EXCLUDED.col`
   *
   * Application-level tenant isolation for when RLS is not available.
   * With Postgres RLS enabled, this option is unnecessary — the policy
   * enforces isolation transparently.
   *
   * Example: Multi-tenant table keyed on `(id)` with an `_account_id` system
   * column. Adding `_account_id` as a guard ensures a row written by account A
   * is only updated by account A — a conflicting upsert from account B becomes
   * a silent no-op instead of overwriting the row.
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

  /**
   * Skip no-op updates via IS DISTINCT FROM (default: true).
   *
   * When true, the ON CONFLICT DO UPDATE adds a WHERE clause that compares
   * every non-volatile column against the existing row. If nothing changed,
   * the UPDATE is skipped entirely — no dead tuple, no trigger fired, no
   * WAL entry.
   *
   * Why it matters:
   * - Stripe backfills re-fetch every object in a time range. Most rows
   *   haven't changed since the last sync — without this, every row gets
   *   a pointless UPDATE that bloats WAL and triggers autovacuum.
   * - CDC / logical replication subscribers see fewer no-op changes.
   * - `updated_at` trigger columns don't get bumped on unchanged rows.
   *
   * Set to false only when every upsert is expected to be a real change
   * (e.g. append-only event logs).
   */
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
    primaryKeyColumns,
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
  const keySet = new Set(primaryKeyColumns)

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
  let sql = `INSERT INTO ${tbl} (${identList(columns)})\nVALUES ${valueRows.join(',\n       ')}\nON CONFLICT (${identList(primaryKeyColumns)})`

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
  try {
    return await client.query(sql, params)
  } catch (err) {
    const table = qualifiedTable(options.schema, options.table)
    const columns = Object.keys(records[0]!)
    const detail =
      `table=${table} columns=[${columns.join(', ')}] ` +
      `pk=[${options.primaryKeyColumns.join(', ')}]` +
      (options.newerThanColumn ? ` newerThan=${options.newerThanColumn}` : '')
    const wrapped = new Error(
      `upsert failed: ${err instanceof Error ? err.message : String(err)} (${detail})`,
      { cause: err }
    )
    if (err instanceof Error) wrapped.stack = err.stack
    throw wrapped
  }
}
