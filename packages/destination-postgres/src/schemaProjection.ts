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
    if (name === 'id') continue // id is always generated from _raw_data

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

/**
 * Build DDL statements to create a table with generated columns from JSON Schema.
 * Returns an array of SQL statements (CREATE TABLE + ALTER TABLE ADD COLUMN for each column
 * + indexes + trigger).
 */
export type SystemColumn = {
  name: string
  type: string
  index?: boolean
}

export type BuildTableOptions = {
  /** Extra system columns to add to the table (e.g. _account_id). */
  system_columns?: SystemColumn[]
}

export function buildCreateTableWithSchema(
  schema: string,
  tableName: string,
  jsonSchema: Record<string, unknown>,
  options: BuildTableOptions = {}
): string[] {
  const quotedSchema = quoteIdent(schema)
  const quotedTable = quoteIdent(tableName)

  const columns = jsonSchemaToColumns(jsonSchema)

  const generatedColumnDefs = columns.map(
    (col) => `${quoteIdent(col.name)} ${col.pgType} GENERATED ALWAYS AS (${col.expression}) STORED`
  )

  const generatedColumnAlters = generatedColumnDefs.map(
    (colDef) => `ALTER TABLE ${quotedSchema}.${quotedTable} ADD COLUMN IF NOT EXISTS ${colDef};`
  )

  const systemColumnDefs = (options.system_columns ?? []).map(
    (col) => `${quoteIdent(col.name)} ${col.type}`
  )

  const columnDefs = [
    '"_raw_data" jsonb NOT NULL',
    '"_last_synced_at" timestamptz',
    '"_updated_at" timestamptz NOT NULL DEFAULT now()',
    ...systemColumnDefs,
    `"id" text GENERATED ALWAYS AS ((_raw_data->>'id')::text) STORED`,
    ...generatedColumnDefs,
    'PRIMARY KEY ("id")',
  ]

  const stmts: string[] = [
    `CREATE TABLE ${quotedSchema}.${quotedTable} (\n  ${columnDefs.join(',\n  ')}\n);`,
    ...generatedColumnAlters,
  ]

  for (const col of options.system_columns ?? []) {
    if (col.index) {
      const idxName = safeIdentifier(`idx_${tableName}_${col.name}`)
      stmts.push(
        `CREATE INDEX ${quoteIdent(idxName)} ON ${quotedSchema}.${quotedTable} (${quoteIdent(col.name)});`
      )
    }
  }

  stmts.push(
    `DROP TRIGGER IF EXISTS handle_updated_at ON ${quotedSchema}.${quotedTable};`,
    `CREATE TRIGGER handle_updated_at BEFORE UPDATE ON ${quotedSchema}.${quotedTable} FOR EACH ROW EXECUTE FUNCTION ${quotedSchema}.set_updated_at();`
  )

  return stmts
}

/**
 * Execute a DDL statement, skipping if the object already exists.
 * Handles: 42P07 (table exists), 42710 (constraint exists),
 * 42P16 (invalid constraint definition), 42701 (column exists).
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
  apiVersion?: string
  /** Progress callback — emitting logs signals liveness to the orchestrator. */
  onLog?: (message: string) => void
}

/**
 * Apply schema from a catalog's json_schema fields to the database.
 * Uses migration markers to avoid redundant DDL.
 */
export async function applySchemaFromCatalog(
  client: PgClient,
  streams: Array<{ name: string; json_schema?: Record<string, unknown> }>,
  config: ApplySchemaFromCatalogConfig = {}
): Promise<void> {
  const dataSchema = config.dataSchema ?? 'public'
  const syncSchema = config.syncSchema ?? dataSchema
  const apiVersion = config.apiVersion ?? '2020-08-27'

  // Compute fingerprint of all json_schemas
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
  for (const [i, stream] of schemasToMigrate.entries()) {
    const start = Date.now()
    const stmts = buildCreateTableWithSchema(dataSchema, stream.name, stream.json_schema!, {
      system_columns: config.system_columns,
    })
    for (const stmt of stmts) {
      await runSqlAdditive(client, stmt)
    }
    config.onLog?.(
      `[${i + 1}/${schemasToMigrate.length}] Migrated "${stream.name}" (${Date.now() - start}ms)`
    )
  }

  await insertMigrationMarker(client, syncSchema, markerColumn, marker, fingerprint)
}
