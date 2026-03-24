import { Client } from 'pg'
import crypto from 'node:crypto'
import type { ConnectionOptions } from 'node:tls'
import { sql } from '@tx-stripe/util-postgres'
import { renderMigrationTemplate } from './migrationTemplate'
import type { Migration } from './migrations'
import { migrations as allMigrations } from './migrations'

/**
 * Simple logger interface compatible with both pino and console
 */
export interface Logger {
  info(message?: unknown, ...optionalParams: unknown[]): void
  warn(message?: unknown, ...optionalParams: unknown[]): void
  error(message?: unknown, ...optionalParams: unknown[]): void
}

export type MigrationConfig = {
  databaseUrl: string
  ssl?: ConnectionOptions
  logger?: Logger
  schemaName?: string
  /** Schema for sync metadata tables (accounts, _sync_runs, etc.). Defaults to schemaName. */
  syncTablesSchemaName?: string
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

async function doesTableExist(client: Client, schema: string, tableName: string): Promise<boolean> {
  const result = await client.query(
    sql`SELECT EXISTS (
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
  schema = 'public',
  logger?: Logger
): Promise<void> {
  const oldTableExists = await doesTableExist(client, schema, 'migrations')
  const newTableExists = await doesTableExist(client, schema, '_migrations')

  if (oldTableExists && !newTableExists) {
    logger?.info('Renaming migrations table to _migrations')
    await client.query(sql`ALTER TABLE "${schema}"."migrations" RENAME TO "_migrations"`)
    logger?.info('Successfully renamed migrations table')
  }
}

async function cleanupSchema(client: Client, schema: string, logger?: Logger): Promise<void> {
  logger?.warn(`Migrations table is empty - dropping and recreating schema "${schema}"`)
  await client.query(sql`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await client.query(sql`CREATE SCHEMA "${schema}"`)
  logger?.info(`Schema "${schema}" has been reset`)
}

export async function runMigrations(config: MigrationConfig): Promise<void> {
  await runMigrationsWithContent(config, allMigrations)
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

function parseMigrations(migrations: Migration[]): ParsedMigration[] {
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

function renderBootstrapMigrations(migrations: Migration[], syncSchema: string): Migration[] {
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
  await client.query(sql`
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
  migrations: Migration[]
): Promise<void> {
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    connectionTimeoutMillis: 10_000,
  })
  const dataSchema = config.schemaName ?? 'public'
  const syncSchema = config.syncTablesSchemaName ?? dataSchema
  const tableName = '_migrations'
  const parsedMigrations = parseMigrations(renderBootstrapMigrations(migrations, syncSchema))

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
      await client.query(sql`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`)
    }
    await client.query(sql`SET search_path TO ${buildSearchPath(syncSchema)}`)
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

    await client.query(sql`SET search_path TO ${buildSearchPath(dataSchema, syncSchema)}`)
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
  migrations: Migration[]
): Promise<void> {
  await runMigrationsWithContent(config, migrations)
}
