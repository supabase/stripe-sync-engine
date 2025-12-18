import { normalizeSigmaTimestampToIso } from './sigmaApi'
import type { RawJsonUpsertOptions } from '../database/postgres'

export type SigmaRow = Record<string, string | null>

export type SigmaCursorColumnType = 'timestamp' | 'string' | 'number'

export type SigmaCursorColumnSpec = {
  column: string
  type: SigmaCursorColumnType
}

export type SigmaCursorSpec = {
  version: 1
  columns: SigmaCursorColumnSpec[]
}

export type SigmaIngestionConfig = {
  /**
   * The Sigma table name to query (no quoting, no schema).
   */
  sigmaTable: string

  /**
   * Destination Postgres table name (in the `stripe` schema by convention).
   */
  destinationTable: string

  /** Limit for each Sigma query page. */
  pageSize: number

  /**
   * Defines the ordering and cursor semantics. The columns must form a total order (i.e. be unique together) or pagination can be incorrect.
   */
  cursor: SigmaCursorSpec

  /** Optional additional WHERE clause appended with AND (must not include leading WHERE). */
  additionalWhere?: string

  /** Columns to SELECT (defaults to `*`). */
  select?: '*' | string[]

  /** Postgres upsert behavior for this table (conflict target and typed columns). */
  upsert: RawJsonUpsertOptions
}

const SIGMA_CURSOR_DELIM = '\u001f' //ascii unit separator

export function escapeSigmaSqlStringLiteral(value: string): string {
  // Escape single-quoted strings
  return value.replace(/'/g, "''")
}

export function formatSigmaTimestampForSqlLiteral(date: Date): string {
  // Emit UTC without timezone suffix
  return date.toISOString().replace('T', ' ').replace('Z', '')
}

export function decodeSigmaCursorValues(spec: SigmaCursorSpec, cursor: string): string[] {
  const prefix = `v${spec.version}${SIGMA_CURSOR_DELIM}`
  if (!cursor.startsWith(prefix)) {
    throw new Error(
      `Unrecognized Sigma cursor format (expected prefix ${JSON.stringify(prefix)}): ${cursor}`
    )
  }

  const parts = cursor.split(SIGMA_CURSOR_DELIM)
  const expected = 1 + spec.columns.length
  if (parts.length !== expected) {
    throw new Error(`Malformed Sigma cursor: expected ${expected} parts, got ${parts.length}`)
  }

  return parts.slice(1)
}

export function encodeSigmaCursor(spec: SigmaCursorSpec, values: string[]): string {
  if (values.length !== spec.columns.length) {
    throw new Error(
      `Cannot encode Sigma cursor: expected ${spec.columns.length} values, got ${values.length}`
    )
  }

  for (const v of values) {
    if (v.includes(SIGMA_CURSOR_DELIM)) {
      throw new Error('Cannot encode Sigma cursor: value contains delimiter character')
    }
  }

  return [`v${spec.version}`, ...values].join(SIGMA_CURSOR_DELIM)
}

function sigmaSqlLiteralForCursorValue(spec: SigmaCursorColumnSpec, rawValue: string): string {
  switch (spec.type) {
    case 'timestamp': {
      const d = new Date(rawValue)
      if (Number.isNaN(d.getTime())) {
        throw new Error(`Invalid timestamp cursor value for ${spec.column}: ${rawValue}`)
      }
      return `timestamp '${formatSigmaTimestampForSqlLiteral(d)}'`
    }
    case 'number': {
      if (!/^-?\d+(\.\d+)?$/.test(rawValue)) {
        throw new Error(`Invalid numeric cursor value for ${spec.column}: ${rawValue}`)
      }
      return rawValue
    }
    case 'string':
      return `'${escapeSigmaSqlStringLiteral(rawValue)}'`
  }
}

export function buildSigmaCursorWhereClause(spec: SigmaCursorSpec, cursorValues: string[]): string {
  if (cursorValues.length !== spec.columns.length) {
    throw new Error(
      `Cannot build Sigma cursor predicate: expected ${spec.columns.length} values, got ${cursorValues.length}`
    )
  }

  const cols = spec.columns.map((c) => c.column)
  const lits = spec.columns.map((c, i) => sigmaSqlLiteralForCursorValue(c, cursorValues[i] ?? ''))

  // (c1 > v1) OR (c1 = v1 AND c2 > v2) OR (c1 = v1 AND c2 = v2 AND c3 > v3) ...
  const ors: string[] = []
  for (let i = 0; i < cols.length; i++) {
    const ands: string[] = []
    for (let j = 0; j < i; j++) {
      ands.push(`${cols[j]} = ${lits[j]}`)
    }
    ands.push(`${cols[i]} > ${lits[i]}`)
    ors.push(`(${ands.join(' AND ')})`)
  }

  return ors.join(' OR ')
}

export function buildSigmaQuery(config: SigmaIngestionConfig, cursor: string | null): string {
  const select =
    config.select === undefined || config.select === '*' ? '*' : config.select.join(', ')

  const whereParts: string[] = []
  if (config.additionalWhere) {
    whereParts.push(`(${config.additionalWhere})`)
  }

  if (cursor) {
    const values = decodeSigmaCursorValues(config.cursor, cursor)
    const predicate = buildSigmaCursorWhereClause(config.cursor, values)
    whereParts.push(`(${predicate})`)
  }

  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''
  const orderBy = config.cursor.columns.map((c) => c.column).join(', ')

  return [
    `SELECT ${select} FROM ${config.sigmaTable}`,
    whereClause,
    `ORDER BY ${orderBy} ASC`,
    `LIMIT ${config.pageSize}`,
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * Prepares a Sigma CSV row for upsert into Postgres.
 * - Keeps all CSV columns in the output (as strings/nulls)
 * - Requires all cursor columns to be present (throws on missing)
 * - Normalizes cursor timestamp columns into ISO UTC strings
 */
export function defaultSigmaRowToEntry(
  config: SigmaIngestionConfig,
  row: SigmaRow
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }

  for (const col of config.cursor.columns) {
    const raw = row[col.column]
    if (raw == null) {
      throw new Error(`Sigma row missing required cursor column: ${col.column}`)
    }

    if (col.type === 'timestamp') {
      const normalized = normalizeSigmaTimestampToIso(raw)
      if (!normalized) {
        throw new Error(`Sigma row has invalid timestamp for ${col.column}: ${raw}`)
      }
      out[col.column] = normalized
    } else if (col.type === 'string') {
      const v = raw.trim()
      if (!v) {
        throw new Error(`Sigma row has empty string for required cursor column: ${col.column}`)
      }
      out[col.column] = v
    } else {
      // number
      const v = raw.trim()
      if (!v) {
        throw new Error(`Sigma row has empty value for required cursor column: ${col.column}`)
      }
      out[col.column] = v
    }
  }

  return out
}

export function sigmaCursorFromEntry(
  config: SigmaIngestionConfig,
  entry: Record<string, unknown>
): string {
  const values = config.cursor.columns.map((c) => {
    const raw = entry[c.column]
    if (raw == null) {
      throw new Error(`Cannot build cursor: entry missing ${c.column}`)
    }
    return String(raw)
  })
  return encodeSigmaCursor(config.cursor, values)
}
