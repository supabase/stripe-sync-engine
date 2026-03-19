import { createHash } from 'node:crypto'
import { resolveOpenApiSpec } from './specFetchHelper'
import { SpecParser, RUNTIME_REQUIRED_TABLES, OPENAPI_RESOURCE_TABLE_ALIASES } from './specParser'
import { PostgresAdapter } from './postgresAdapter'
import { WritePathPlanner } from './writePathPlanner'

interface Logger {
  info(message?: unknown, ...optionalParams: unknown[]): void
  warn(message?: unknown, ...optionalParams: unknown[]): void
  error(message?: unknown, ...optionalParams: unknown[]): void
}

interface PgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export type ApplyStripeSchemaConfig = {
  stripeApiVersion?: string
  openApiSpecPath?: string
  openApiCacheDir?: string
  schemaName?: string
  syncTablesSchemaName?: string
  logger?: Logger
}

const DEFAULT_STRIPE_API_VERSION = '2020-08-27'

function computeOpenApiFingerprint(spec: unknown): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16)
}

function isLegacyOpenApiCommitMarker(
  marker: string,
  dataSchema: string,
  apiVersion: string
): boolean {
  const markerPrefix = `openapi:${dataSchema}:${apiVersion}:`
  if (!marker.startsWith(markerPrefix)) {
    return false
  }
  const suffix = marker.slice(markerPrefix.length)
  return /^[0-9a-f]{40}$/i.test(suffix)
}

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

type MigrationMarkerColumn = 'migration_name' | 'name'

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

async function runSqlAdditive(client: PgClient, sql: string, logger?: Logger): Promise<void> {
  try {
    await client.query(sql)
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code
    if (code === '42P07' || code === '42710' || code === '42P16' || code === '42701') {
      logger?.info?.({ code }, 'Skipping already-existing object (additive apply)')
      return
    }
    throw err
  }
}

/**
 * Apply Stripe OpenAPI-generated table schema to the database.
 * This resolves the Stripe OpenAPI spec and creates/updates tables with generated columns.
 * Should be called after bootstrap migrations have been applied.
 */
export async function applyStripeSchema(
  client: PgClient,
  config: ApplyStripeSchemaConfig
): Promise<void> {
  const dataSchema = config.schemaName ?? 'stripe'
  const syncSchema = config.syncTablesSchemaName ?? dataSchema
  const apiVersion = config.stripeApiVersion ?? DEFAULT_STRIPE_API_VERSION

  const resolvedSpec = await resolveOpenApiSpec({
    apiVersion,
    openApiSpecPath: config.openApiSpecPath,
    cacheDir: config.openApiCacheDir,
  })
  const fingerprint = computeOpenApiFingerprint(resolvedSpec.spec)
  const marker = `openapi:${dataSchema}:${apiVersion}:${fingerprint}`

  config.logger?.info(
    {
      apiVersion,
      source: resolvedSpec.source,
      commitSha: resolvedSpec.commitSha,
      fingerprint,
    },
    'Resolved Stripe OpenAPI spec'
  )

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
  if (existingMarkers.includes(marker)) {
    config.logger?.info({ marker }, 'OpenAPI schema already applied, skipping')
    return
  }

  if (
    resolvedSpec.source !== 'explicit_path' &&
    existingMarkers.some((existingMarker) =>
      isLegacyOpenApiCommitMarker(existingMarker, dataSchema, apiVersion)
    )
  ) {
    config.logger?.info(
      {
        marker,
        existingMarkerCount: existingMarkers.length,
      },
      'OpenAPI schema already applied via legacy marker, skipping'
    )
    return
  }

  const parser = new SpecParser()
  const parsedSpec = parser.parse(resolvedSpec.spec, {
    resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    allowedTables: [...RUNTIME_REQUIRED_TABLES],
  })
  const adapter = new PostgresAdapter({
    schemaName: dataSchema,
    accountSchema: syncSchema,
  })
  const statements = adapter.buildAllStatements(parsedSpec.tables)
  for (const statement of statements) {
    await runSqlAdditive(client, statement, config.logger)
  }

  await insertMigrationMarker(client, syncSchema, markerColumn, marker, fingerprint)

  const planner = new WritePathPlanner()
  const writePlans = planner.buildPlans(parsedSpec.tables)
  config.logger?.info(
    {
      tableCount: parsedSpec.tables.length,
      writePlanCount: writePlans.length,
      marker,
    },
    'Applied OpenAPI-generated Stripe tables'
  )
}
