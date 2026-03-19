import { Client } from 'pg'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ConnectionOptions } from 'node:tls'
import type { Logger } from '../types'
import { renderMigrationTemplate } from './migrationTemplate'
import {
  OPENAPI_RESOURCE_TABLE_ALIASES,
  PostgresAdapter,
  RUNTIME_REQUIRED_TABLES,
  SpecParser,
  WritePathPlanner,
  resolveOpenApiSpec,
} from '../openapi'
import type { EmbeddedMigration } from './migrations-embedded'

const DEFAULT_STRIPE_API_VERSION = '2020-08-27'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

type MigrationConfig = {
  databaseUrl: string
  ssl?: ConnectionOptions
  logger?: Logger
  stripeApiVersion?: string
  openApiSpecPath?: string
  openApiCacheDir?: string
  schemaName?: string
  /** Schema for sync metadata tables (accounts, _sync_runs, etc.). Defaults to schemaName. */
  syncTablesSchemaName?: string
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

async function doesTableExist(client: Client, schema: string, tableName: string): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = $1
      AND table_name = $2
    )`,
    [schema, tableName]
  )
  return result.rows[0]?.exists || false
}

async function renameMigrationsTableIfNeeded(
  client: Client,
  schema = 'stripe',
  logger?: Logger
): Promise<void> {
  const oldTableExists = await doesTableExist(client, schema, 'migrations')
  const newTableExists = await doesTableExist(client, schema, '_migrations')

  if (oldTableExists && !newTableExists) {
    logger?.info('Renaming migrations table to _migrations')
    await client.query(`ALTER TABLE "${schema}"."migrations" RENAME TO "_migrations"`)
    logger?.info('Successfully renamed migrations table')
  }
}

async function cleanupSchema(client: Client, schema: string, logger?: Logger): Promise<void> {
  logger?.warn(`Migrations table is empty - dropping and recreating schema "${schema}"`)
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await client.query(`CREATE SCHEMA "${schema}"`)
  logger?.info(`Schema "${schema}" has been reset`)
}

/** Run SQL, ignoring "already exists" errors (additive apply). Rethrows other errors. */
async function runSqlAdditive(client: Client, sql: string, logger?: Logger): Promise<void> {
  try {
    await client.query(sql)
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code
    // 42P07=duplicate_table, 42710=duplicate_object (index/constraint), 42P16=invalid_table_definition
    if (code === '42P07' || code === '42710' || code === '42P16' || code === '42701') {
      logger?.info?.({ code }, 'Skipping already-existing object (additive apply)')
      return
    }
    throw err
  }
}

type MigrationMarkerColumn = 'migration_name' | 'name'

async function getMigrationMarkerColumn(
  client: Client,
  schema: string
): Promise<MigrationMarkerColumn> {
  const colCheck = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = '_migrations' AND column_name IN ('migration_name', 'name')`,
    [schema]
  )
  const hasMigrationName = colCheck.rows.some((r) => r.column_name === 'migration_name')
  if (hasMigrationName) return 'migration_name'
  const hasName = colCheck.rows.some((r) => r.column_name === 'name')
  if (hasName) return 'name'
  throw new Error(
    `Unsupported _migrations schema in "${schema}" (expected migration_name or name column).`
  )
}

async function insertMigrationMarker(
  client: Client,
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

  // Use negative IDs so OpenAPI markers never collide with file migration IDs (0, 1, 2, ...).
  const idResult = await client.query(
    `SELECT COALESCE(MIN(id), 0) - 1 as next_id FROM "${schema}"."_migrations" WHERE id < 0`
  )
  const nextId = Number(idResult.rows[0]?.next_id ?? -1)
  await client.query(
    `INSERT INTO "${schema}"."_migrations" (id, name, hash) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
    [nextId, marker, hash]
  )
}

function computeOpenApiFingerprint(spec: unknown): string {
  // Use a content-derived fingerprint so marker identity is stable across spec sources.
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

async function listOpenApiMarkersForVersion(
  client: Client,
  schema: string,
  markerColumn: MigrationMarkerColumn,
  dataSchema: string,
  apiVersion: string
): Promise<string[]> {
  const markerPrefix = `openapi:${dataSchema}:${apiVersion}:`
  const result = await client.query<{ marker: string }>(
    `SELECT "${markerColumn}" AS marker
     FROM "${schema}"."_migrations"
     WHERE "${markerColumn}" LIKE $1`,
    [`${markerPrefix}%`]
  )

  return result.rows
    .map((row) => row.marker)
    .filter((marker): marker is string => typeof marker === 'string')
}

async function applyOpenApiSchema(
  client: Client,
  config: MigrationConfig,
  dataSchema: string,
  syncSchema: string
): Promise<void> {
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

  // Ensure _migrations exists (the migration runner creates it; legacy installs may use
  // the older migration-table shape).
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

  // Backward compatibility:
  // older branches stored marker suffixes as 40-char commit SHAs. Treat those as equivalent
  // for GitHub/cache-resolved specs to prevent duplicate markers for the same API version.
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

export async function runMigrations(config: MigrationConfig): Promise<void> {
  const migrationsDirectory = path.resolve(__dirname, './migrations')
  const migrations = loadMigrationsFromDirectory(migrationsDirectory)
  config.logger?.info(
    { migrationsDirectory, migrationCount: migrations.length },
    'Loaded bootstrap migrations from directory'
  )
  await runMigrationsWithContent(config, migrations)
}

// Helper to parse migration ID from filename (matches the historical migration filename convention)
function parseMigrationId(fileName: string): number {
  const match = /^(-?\d+)[-_]?/.exec(fileName)
  if (!match) {
    throw new Error(`Invalid migration file name: '${fileName}'`)
  }
  return parseInt(match[1], 10)
}

// Helper to compute hash using the historical fileName+sql SHA-1 convention
function computeMigrationHash(fileName: string, sql: string): string {
  return crypto
    .createHash('sha1')
    .update(fileName + sql, 'utf8')
    .digest('hex')
}

type ParsedMigration = {
  id: number
  name: string
  fileName: string
  sql: string
  hash: string
}

function parseMigrations(migrations: EmbeddedMigration[]): ParsedMigration[] {
  return migrations
    .map((migration) => ({
      id: parseMigrationId(migration.name),
      name: migration.name.replace(/^\d+[-_]?/, '').replace(/\.sql$/, '') || migration.name,
      fileName: migration.name,
      sql: migration.sql,
      hash: computeMigrationHash(migration.name, migration.sql),
    }))
    .sort((a, b) => a.id - b.id)
}

function loadMigrationsFromDirectory(migrationsDirectory: string): EmbeddedMigration[] {
  if (!fs.existsSync(migrationsDirectory)) {
    throw new Error(`Migrations directory not found. ${migrationsDirectory} does not exist.`)
  }

  return fs
    .readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort()
    .map((fileName) => ({
      name: fileName,
      sql: fs.readFileSync(path.join(migrationsDirectory, fileName), 'utf8'),
    }))
}

function renderBootstrapMigrations(
  migrations: EmbeddedMigration[],
  syncSchema: string
): EmbeddedMigration[] {
  return migrations.map((migration) => ({
    ...migration,
    sql: renderMigrationTemplate(migration.sql, { syncSchema }),
  }))
}

function buildSearchPath(...schemas: string[]): string {
  const uniqueSchemas = [...new Set(schemas.filter((schema) => schema.length > 0))]
  return [...uniqueSchemas.map(quoteIdentifier), 'public'].join(', ')
}

async function ensureMigrationsTable(
  client: Client,
  schema: string,
  tableName: string
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "${schema}"."${tableName}" (
      id integer PRIMARY KEY,
      name varchar(100) UNIQUE NOT NULL,
      hash varchar(40) NOT NULL,
      executed_at timestamp DEFAULT current_timestamp
    )
  `)
}

async function getAppliedMigrations(
  client: Client,
  schema: string,
  tableName: string
): Promise<{ id: number; name: string; hash: string }[]> {
  const tableExists = await doesTableExist(client, schema, tableName)
  if (!tableExists) {
    return []
  }
  const result = await client.query(
    `SELECT id, name, hash FROM "${schema}"."${tableName}" ORDER BY id`
  )
  return result.rows
}

async function runMigration(
  client: Client,
  schema: string,
  tableName: string,
  migration: ParsedMigration,
  logger?: Logger
): Promise<void> {
  logger?.info(`Running migration: ${migration.id} ${migration.name}`)

  await client.query('BEGIN')
  try {
    await client.query(migration.sql)
    await client.query(
      `INSERT INTO "${schema}"."${tableName}" (id, name, hash) VALUES ($1, $2, $3)`,
      [migration.id, migration.name, migration.hash]
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

async function runMigrationsWithContent(
  config: MigrationConfig,
  migrations: EmbeddedMigration[]
): Promise<void> {
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    connectionTimeoutMillis: 10_000,
  })
  const dataSchema = config.schemaName ?? 'stripe'
  const syncSchema = config.syncTablesSchemaName ?? dataSchema
  const tableName = '_migrations'
  const parsedMigrations = parseMigrations(renderBootstrapMigrations(migrations, syncSchema))

  // In this codepath, a "custom schema name" means using one non-default schema name
  // instead of "stripe". It does not mean split data and metadata schemas.
  // todo: split-schema (different data and sync-metadata schemas) is not yet supported
  // because several internal SQL statements mix the two without proper parameterisation.
  if (dataSchema !== syncSchema) {
    throw new Error(
      `Split schema configuration is not supported: schemaName ("${dataSchema}") and ` +
        `syncTablesSchemaName ("${syncSchema}") must be the same value.`
    )
  }

  try {
    config.logger?.info(
      { migrationCount: parsedMigrations.length },
      'Starting migrations from content'
    )
    await client.connect()
    for (const schema of new Set([syncSchema, dataSchema])) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`)
    }
    await client.query(`SET search_path TO ${buildSearchPath(syncSchema)}`)
    await renameMigrationsTableIfNeeded(client, syncSchema, config.logger)

    const tableExists = await doesTableExist(client, syncSchema, tableName)
    if (tableExists) {
      const migrationCount = await client.query(
        `SELECT COUNT(*) as count FROM "${syncSchema}"."${tableName}"`
      )
      const isEmpty = migrationCount.rows[0]?.count === '0'
      if (isEmpty) {
        await cleanupSchema(client, syncSchema, config.logger)
      }
    }

    await ensureMigrationsTable(client, syncSchema, tableName)

    // Only consider file migrations for validation; OpenAPI markers are stored separately (negative IDs).
    let appliedMigrations = (await getAppliedMigrations(client, syncSchema, tableName)).filter(
      (m) => !m.name.startsWith('openapi:')
    )
    const appliedInitial = appliedMigrations.find((migration) => migration.id === 0)
    const intendedInitial = parsedMigrations.find((migration) => migration.id === 0)
    if (appliedInitial && intendedInitial && appliedInitial.hash !== intendedInitial.hash) {
      config.logger?.warn(
        'Initial migration (0) hash changed — resetting schema to reapply from scratch'
      )
      await cleanupSchema(client, syncSchema, config.logger)
      await ensureMigrationsTable(client, syncSchema, tableName)
      appliedMigrations = []
    } else {
      for (const applied of appliedMigrations) {
        const intended = parsedMigrations.find((migration) => migration.id === applied.id)
        if (intended && intended.hash !== applied.hash) {
          throw new Error(
            `Migration hash mismatch for ${applied.name}: ` +
              `expected ${intended.hash}, got ${applied.hash}. ` +
              `Migrations cannot be modified after being applied.`
          )
        }
      }
    }

    const appliedIds = new Set(appliedMigrations.map((migration) => migration.id))
    const pendingMigrations = parsedMigrations.filter((migration) => !appliedIds.has(migration.id))
    if (pendingMigrations.length === 0) {
      config.logger?.info('No migrations to run')
    } else {
      config.logger?.info(`Running ${pendingMigrations.length} migration(s)`)
      for (const migration of pendingMigrations) {
        await runMigration(client, syncSchema, tableName, migration, config.logger)
      }
      config.logger?.info(`Successfully applied ${pendingMigrations.length} migration(s)`)
    }

    await client.query(`SET search_path TO ${buildSearchPath(dataSchema, syncSchema)}`)
    await applyOpenApiSchema(client, config, dataSchema, syncSchema)
  } catch (err) {
    config.logger?.error(err, 'Error running migrations')
    throw err
  } finally {
    await client.end()
    config.logger?.info('Finished migrations')
  }
}

/**
 * Run migrations from embedded content (for edge runtimes without filesystem migrations access).
 * This uses the same in-memory execution path as the Node bootstrap runner.
 */
export async function runMigrationsFromContent(
  config: MigrationConfig,
  migrations: EmbeddedMigration[]
): Promise<void> {
  await runMigrationsWithContent(config, migrations)
}
