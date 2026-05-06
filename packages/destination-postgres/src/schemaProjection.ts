import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

const PG_IDENTIFIER_MAX_BYTES = 63

type ColumnDef = {
  name: string
  pgType: string
  expression: string
  expandableReference: boolean
}

interface PgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/** Standard SQL string literal quoting — escape single quotes by doubling. */
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function safeIdentifier(name: string): string {
  if (Buffer.byteLength(name) <= PG_IDENTIFIER_MAX_BYTES) {
    return name
  }
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8)
  const suffix = `_h${hash}`
  const maxBaseBytes = PG_IDENTIFIER_MAX_BYTES - Buffer.byteLength(suffix)
  const truncatedBase = Buffer.from(name).subarray(0, maxBaseBytes).toString('utf8')
  return `${truncatedBase}${suffix}`
}

/** Deterministic name of a per-table per-column enum CHECK constraint. */
export function enumCheckConstraintName(tableName: string, columnName: string): string {
  return safeIdentifier(`chk_${tableName}_${columnName}`)
}

function jsonSchemaTypeToPg(prop: Record<string, unknown>): string {
  const type = prop.type as string | undefined
  const format = prop.format as string | undefined

  switch (type) {
    case 'string':
      // date-time stays text for safety (no timezone parsing issues)
      return format === 'date-time' ? 'text' : 'text'
    case 'boolean':
      return 'boolean'
    case 'integer':
      return 'bigint'
    case 'number':
      return 'numeric'
    case 'object':
      return 'jsonb'
    default:
      return 'text'
  }
}

function buildExpandableReferenceExpression(escapedPath: string): string {
  const jsonPath = `_raw_data->'${escapedPath}'`
  return `CASE
      WHEN jsonb_typeof(${jsonPath}) = 'object' AND ${jsonPath} ? 'id'
        THEN (${jsonPath}->>'id')
      ELSE (_raw_data->>'${escapedPath}')
    END`
}

/** Convert a JSON Schema's properties into Postgres column definitions. */
export function jsonSchemaToColumns(jsonSchema: Record<string, unknown>): ColumnDef[] {
  const properties = jsonSchema.properties as Record<string, Record<string, unknown>> | undefined
  if (!properties) return []

  const columns: ColumnDef[] = []
  for (const [name, prop] of Object.entries(properties)) {
    if (name === 'id') continue
    // `_updated_at` is hardcoded below; upsertMany writes it (DDR-009).
    if (name === '_updated_at') continue

    const isExpandableRef = prop['x-expandable-reference'] === true
    const pgType = isExpandableRef ? 'text' : jsonSchemaTypeToPg(prop)
    const escapedPath = name.replace(/'/g, "''")

    let expression: string
    if (isExpandableRef) {
      expression = buildExpandableReferenceExpression(escapedPath)
    } else if (pgType === 'jsonb') {
      expression = `(_raw_data->'${escapedPath}')::jsonb`
    } else if (pgType === 'text') {
      expression = `(_raw_data->>'${escapedPath}')::text`
    } else {
      expression = `(NULLIF(_raw_data->>'${escapedPath}', ''))::${pgType}`
    }

    columns.push({ name, pgType, expression, expandableReference: isExpandableRef })
  }

  return columns
}

export type SystemColumn = {
  name: string
  type: string
  index?: boolean
}

export type BuildTableOptions = {
  /** Extra system columns to add to the table (e.g. _account_id). */
  system_columns?: SystemColumn[]
  /** Primary key paths from the stream (e.g. [['id'], ['_account_id']]). Defaults to [['id']]. */
  primary_key?: string[][]
}

/**
 * Build DDL statements to create a table with generated columns from JSON Schema.
 * Returns an array of individual SQL statements (CREATE TABLE, ALTER TABLE,
 * indexes, triggers). Prefer {@link buildCreateTableDDL} for fewer round trips.
 */
export function buildCreateTableWithSchema(
  schema: string,
  tableName: string,
  jsonSchema: Record<string, unknown>,
  options: BuildTableOptions = {}
): string[] {
  const quotedSchema = quoteIdent(schema)
  const quotedTable = quoteIdent(tableName)

  const pkFields = (options.primary_key ?? [['id']]).map((pk) => pk[0])
  const pkSet = new Set(pkFields)

  const columns = jsonSchemaToColumns(jsonSchema).filter((c) => !pkSet.has(c.name))

  const generatedColumnDefs = columns.map(
    (col) => `${quoteIdent(col.name)} ${col.pgType} GENERATED ALWAYS AS (${col.expression}) STORED`
  )

  const systemColumnDefs = (options.system_columns ?? []).map(
    (col) => `${quoteIdent(col.name)} ${col.type}`
  )

  const pkColumnDefs = pkFields.map((field) => {
    const escapedField = field.replace(/'/g, "''")
    return `${quoteIdent(field)} text GENERATED ALWAYS AS ((_raw_data->>'${escapedField}')::text) STORED`
  })
  // `_updated_at` kept as legacy non-generated timestamptz for BC; upsertMany writes it (DDR-009).
  const columnDefs = [
    '"_raw_data" jsonb NOT NULL',
    '"_last_synced_at" timestamptz',
    '"_updated_at" timestamptz NOT NULL DEFAULT now()',
    ...systemColumnDefs,
    ...pkColumnDefs,
    ...generatedColumnDefs,
    `PRIMARY KEY (${pkFields.map((f) => quoteIdent(f)).join(', ')})`,
  ]

  const stmts: string[] = [
    `CREATE TABLE ${quotedSchema}.${quotedTable} (\n  ${columnDefs.join(',\n  ')}\n);`,
  ]

  if (generatedColumnDefs.length > 0) {
    const addClauses = generatedColumnDefs.map((colDef) => `ADD COLUMN IF NOT EXISTS ${colDef}`)
    stmts.push(`ALTER TABLE ${quotedSchema}.${quotedTable}\n  ${addClauses.join(',\n  ')};`)
  }

  for (const col of options.system_columns ?? []) {
    if (col.index) {
      const idxName = safeIdentifier(`idx_${tableName}_${col.name}`)
      stmts.push(
        `CREATE INDEX ${quoteIdent(idxName)} ON ${quotedSchema}.${quotedTable} (${quoteIdent(col.name)});`
      )
    }
  }

  const properties = jsonSchema.properties as Record<string, { enum?: string[] }> | undefined
  if (properties) {
    for (const [colName, prop] of Object.entries(properties)) {
      if (!Array.isArray(prop?.enum) || prop.enum.length === 0) continue
      const qn = quoteIdent(enumCheckConstraintName(tableName, colName))
      const escapedCol = colName.replace(/'/g, "''")
      const list = prop.enum.map(quoteLiteral).join(', ')
      stmts.push(
        `DO $check$\nBEGIN\n  ALTER TABLE ${quotedSchema}.${quotedTable} ADD CONSTRAINT ${qn} CHECK ((_raw_data->>'${escapedCol}') IS NOT NULL AND (_raw_data->>'${escapedCol}') IN (${list}));\nEXCEPTION WHEN duplicate_object OR undefined_table THEN NULL;\nEND;\n$check$;`
      )
    }
  }

  // Drop the legacy trigger; `_updated_at` is now written explicitly by upsertMany.
  stmts.push(`DROP TRIGGER IF EXISTS handle_updated_at ON ${quotedSchema}.${quotedTable};`)

  return stmts
}

/**
 * Wrap a DDL statement in BEGIN…EXCEPTION so it's skipped when the object already
 * exists.  Mirrors the error codes handled by {@link runSqlAdditive}.
 */
function wrapAdditive(stmt: string): string {
  return `BEGIN\n    ${stmt}\n  EXCEPTION WHEN duplicate_table OR duplicate_object OR duplicate_column OR invalid_table_definition THEN NULL;\n  END;`
}

/**
 * Build a single SQL string (a DO block) that idempotently creates a table with
 * generated columns from JSON Schema, adds missing columns, indexes, and the
 * updated_at trigger.  Sends exactly **one round trip** to the database.
 *
 * Delegates to {@link buildCreateTableWithSchema} for the statement list, then
 * wraps each mutating statement in BEGIN…EXCEPTION for idempotency.
 */
export function buildCreateTableDDL(
  schema: string,
  tableName: string,
  jsonSchema: Record<string, unknown>,
  options: BuildTableOptions = {}
): string {
  const stmts = buildCreateTableWithSchema(schema, tableName, jsonSchema, options)
  const isStandalone = (s: string) => /^DO\s/i.test(s)
  const blocks = stmts
    .filter((s) => !isStandalone(s))
    .map((s) => (/^DROP\s/i.test(s) ? s : wrapAdditive(s)))
  return [
    `DO $ddl$\nBEGIN\n  ${blocks.join('\n  ')}\nEND;\n$ddl$;`,
    ...stmts.filter(isStandalone),
  ].join('\n')
}

/**
 * For each requested table, return the set of enum values currently enforced
 * by `chk_<table>_<column>` CHECK constraints. Tables/columns with no such
 * constraint are absent from the map.
 *
 * Used by destination setup to detect mismatched allow-lists and fail loud
 * — re-running setup with a different list would otherwise no-op via the
 * `EXCEPTION WHEN duplicate_object` clause and leave the old predicate.
 *
 * @returns Map<tableName, Map<columnName, Set<values>>>
 */
export async function getExistingEnumAllowLists(
  client: PgClient,
  schema: string,
  tableNames: string[],
  columnNames: string[]
): Promise<Map<string, Map<string, Set<string>>>> {
  if (tableNames.length === 0 || columnNames.length === 0) return new Map()
  const constraintLookup = new Map<string, { table: string; column: string }>()
  for (const t of tableNames) {
    for (const c of columnNames) {
      constraintLookup.set(enumCheckConstraintName(t, c), { table: t, column: c })
    }
  }
  const result = await client.query(
    `SELECT c.conname AS conname, pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = $1 AND c.contype = 'c' AND c.conname = ANY($2::text[])`,
    [schema, [...constraintLookup.keys()]]
  )
  const out = new Map<string, Map<string, Set<string>>>()
  for (const row of result.rows) {
    const info = constraintLookup.get(row.conname as string)
    if (!info) continue
    const def = row.def as string
    const vals = new Set<string>()
    // Extract values from the IN (...) or ANY (ARRAY[...]) clause only,
    // skipping column references like '_account_id'::text in the expression.
    const inMatch = def.match(/\bIN\s*\(([^)]+)\)/i) ?? def.match(/\bARRAY\[([^\]]+)\]/i)
    if (inMatch) {
      for (const m of inMatch[1].matchAll(/'((?:[^']|'')*)'/g)) {
        vals.add(m[1].replaceAll("''", "'"))
      }
    }
    if (vals.size > 0) {
      let tableMap = out.get(info.table)
      if (!tableMap) {
        tableMap = new Map()
        out.set(info.table, tableMap)
      }
      tableMap.set(info.column, vals)
    }
  }
  return out
}

/**
 * Execute a DDL statement, skipping if the object already exists.
 * Handles: 42P07 (table exists), 42710 (constraint exists),
 * 42P16 (invalid constraint definition), 42701 (column exists).
 *
 * @deprecated No longer used internally — {@link buildCreateTableDDL} handles
 * idempotency inside a PL/pgSQL DO block instead. Kept for external callers.
 */
export async function runSqlAdditive(client: PgClient, sql: string): Promise<void> {
  try {
    await client.query(sql)
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code
    if (code === '42P07' || code === '42710' || code === '42P16' || code === '42701') {
      return
    }
    throw err
  }
}

// -- Migration marker tracking --

type MigrationMarkerColumn = 'migration_name' | 'name'

async function doesTableExist(
  client: PgClient,
  schema: string,
  tableName: string
): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = $1
      AND table_name = $2
    )`,
    [schema, tableName]
  )
  return (result.rows[0]?.exists as boolean) || false
}

async function getMigrationMarkerColumn(
  client: PgClient,
  schema: string
): Promise<MigrationMarkerColumn> {
  const colCheck = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = '_migrations' AND column_name IN ('migration_name', 'name')`,
    [schema]
  )
  const hasMigrationName = colCheck.rows.some((r) => (r.column_name as string) === 'migration_name')
  if (hasMigrationName) return 'migration_name'
  const hasName = colCheck.rows.some((r) => (r.column_name as string) === 'name')
  if (hasName) return 'name'
  throw new Error(
    `Unsupported _migrations schema in "${schema}" (expected migration_name or name column).`
  )
}

function isLegacyOpenApiCommitMarker(
  marker: string,
  dataSchema: string,
  apiVersion: string
): boolean {
  const markerPrefix = `openapi:${dataSchema}:${apiVersion}:`
  if (!marker.startsWith(markerPrefix)) return false
  const suffix = marker.slice(markerPrefix.length)
  return /^[0-9a-f]{40}$/i.test(suffix)
}

async function listOpenApiMarkersForVersion(
  client: PgClient,
  schema: string,
  markerColumn: MigrationMarkerColumn,
  dataSchema: string,
  apiVersion: string
): Promise<string[]> {
  const markerPrefix = `openapi:${dataSchema}:${apiVersion}:`
  const result = await client.query(
    `SELECT "${markerColumn}" AS marker
     FROM "${schema}"."_migrations"
     WHERE "${markerColumn}" LIKE $1`,
    [`${markerPrefix}%`]
  )
  return result.rows
    .map((row) => row.marker as string)
    .filter((marker): marker is string => typeof marker === 'string')
}

async function insertMigrationMarker(
  client: PgClient,
  schema: string,
  markerColumn: MigrationMarkerColumn,
  marker: string,
  hash: string
): Promise<void> {
  if (markerColumn === 'migration_name') {
    await client.query(
      `INSERT INTO "${schema}"."_migrations" ("migration_name") VALUES ($1) ON CONFLICT ("migration_name") DO NOTHING`,
      [marker]
    )
    return
  }
  const idResult = await client.query(
    `SELECT COALESCE(MIN(id), 0) - 1 as next_id FROM "${schema}"."_migrations" WHERE id < 0`
  )
  const nextId = Number((idResult.rows[0]?.next_id as number) ?? -1)
  await client.query(
    `INSERT INTO "${schema}"."_migrations" (id, name, hash) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
    [nextId, marker, hash]
  )
}

export type ApplySchemaFromCatalogConfig = {
  dataSchema?: string
  syncSchema?: string
  /** Extra system columns to add to each table. */
  system_columns?: SystemColumn[]
  /** Primary key paths (e.g. [['id'], ['_account_id']]). Defaults to [['id']]. */
  primary_key?: string[][]
  apiVersion?: string
  /** Progress callback — emitting logs signals liveness to the orchestrator. */
  onLog?: (message: string) => void
}

/**
 * Apply schema from a catalog's json_schema fields to the database.
 * Uses migration markers to avoid redundant DDL.
 *
 * Tables are migrated concurrently via `Promise.all`. For true parallelism,
 * pass a `pg.Pool` (which multiplexes across connections); a single `pg.Client`
 * will serialize queries on its connection.
 */
export async function applySchemaFromCatalog(
  client: PgClient,
  streams: Array<{ name: string; json_schema?: Record<string, unknown> }>,
  config: ApplySchemaFromCatalogConfig = {}
): Promise<void> {
  const dataSchema = config.dataSchema ?? 'public'
  const syncSchema = config.syncSchema ?? dataSchema
  const apiVersion = config.apiVersion ?? '2020-08-27'

  // The fingerprint is taken over the full json_schema of every stream,
  // which includes any enum arrays, so allow-list changes roll into the
  // hash naturally — no separate extraction needed.
  const schemasPayload = streams
    .filter((s) => s.json_schema)
    .map((s) => ({ name: s.name, json_schema: s.json_schema }))
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(schemasPayload))
    .digest('hex')
    .slice(0, 16)
  const marker = `openapi:${dataSchema}:${apiVersion}:${fingerprint}`

  const migrationsExists = await doesTableExist(client, syncSchema, '_migrations')
  if (!migrationsExists) {
    throw new Error(`_migrations table not found in schema "${syncSchema}". Run bootstrap first.`)
  }

  const markerColumn = await getMigrationMarkerColumn(client, syncSchema)
  const existingMarkers = await listOpenApiMarkersForVersion(
    client,
    syncSchema,
    markerColumn,
    dataSchema,
    apiVersion
  )

  if (existingMarkers.includes(marker)) return

  if (
    existingMarkers.some((existingMarker) =>
      isLegacyOpenApiCommitMarker(existingMarker, dataSchema, apiVersion)
    )
  ) {
    return
  }

  const schemasToMigrate = streams.filter((s) => s.json_schema)
  config.onLog?.(`Migrating ${schemasToMigrate.length} tables (marker: ${marker.slice(0, 24)}…)`)
  const total = schemasToMigrate.length
  let completed = 0
  await Promise.all(
    schemasToMigrate.map(async (stream) => {
      const start = Date.now()
      await client.query(
        buildCreateTableDDL(dataSchema, stream.name, stream.json_schema!, {
          system_columns: config.system_columns,
          primary_key: config.primary_key,
        })
      )
      config.onLog?.(
        `[${++completed}/${total}] Migrated "${stream.name}" (${Date.now() - start}ms)`
      )
    })
  )

  await insertMigrationMarker(client, syncSchema, markerColumn, marker, fingerprint)
}
