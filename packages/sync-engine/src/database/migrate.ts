import { Client } from 'pg'
import { migrate } from 'pg-node-migrations'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ConnectionOptions } from 'node:tls'
import type { Logger } from '../types'
import type { EmbeddedMigration } from './migrations-embedded'

// Get __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

type MigrationConfig = {
  databaseUrl: string
  ssl?: ConnectionOptions
  logger?: Logger
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

async function connectAndMigrate(
  client: Client,
  migrationsDirectory: string,
  config: MigrationConfig,
  logOnError = false
) {
  if (!fs.existsSync(migrationsDirectory)) {
    throw new Error(`Migrations directory not found. ${migrationsDirectory} does not exist.`)
  }

  const optionalConfig = {
    schemaName: 'stripe',
    tableName: '_migrations',
  }

  try {
    await migrate({ client }, migrationsDirectory, optionalConfig)
  } catch (error) {
    if (logOnError && error instanceof Error) {
      config.logger?.error(error, 'Migration error:')
    } else {
      throw error
    }
  }
}

export async function runMigrations(config: MigrationConfig): Promise<void> {
  // Init DB
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    connectionTimeoutMillis: 10_000,
  })

  const schema = 'stripe'

  try {
    console.log('Starting migrations')
    // Run migrations
    await client.connect()
    console.log('Connected to database')

    // Ensure schema exists, not doing it via migration to not break current migration checksums
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema};`)

    // Rename old migrations table if it exists (one-time upgrade to internal table naming convention)
    await renameMigrationsTableIfNeeded(client, schema, config.logger)

    // Check if migrations table is empty and cleanup if needed
    const tableExists = await doesTableExist(client, schema, '_migrations')
    if (tableExists) {
      const migrationCount = await client.query(
        `SELECT COUNT(*) as count FROM "${schema}"."_migrations"`
      )
      const isEmpty = migrationCount.rows[0]?.count === '0'
      if (isEmpty) {
        await cleanupSchema(client, schema, config.logger)
      }
    }

    config.logger?.info('Running migrations')

    await connectAndMigrate(client, path.resolve(__dirname, './migrations'), config, true)
  } catch (err) {
    config.logger?.error(err, 'Error running migrations')
    throw err
  } finally {
    await client.end()
    config.logger?.info('Finished migrations')
  }
}

// Helper to parse migration ID from filename (matches pg-node-migrations behavior)
function parseMigrationId(fileName: string): number {
  const match = /^(-?\d+)[-_]?/.exec(fileName)
  if (!match) {
    throw new Error(`Invalid migration file name: '${fileName}'`)
  }
  return parseInt(match[1], 10)
}

// Helper to compute hash matching pg-node-migrations format
function computeMigrationHash(fileName: string, sql: string): string {
  return crypto.createHash('sha1').update(fileName + sql, 'utf8').digest('hex')
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
    .map((m) => ({
      id: parseMigrationId(m.name),
      name: m.name.replace(/^\d+[-_]?/, '').replace(/\.sql$/, '') || m.name,
      fileName: m.name,
      sql: m.sql,
      hash: computeMigrationHash(m.name, m.sql),
    }))
    .sort((a, b) => a.id - b.id)
}

async function ensureMigrationsTable(client: Client, schema: string, tableName: string): Promise<void> {
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
  const result = await client.query(`SELECT id, name, hash FROM "${schema}"."${tableName}" ORDER BY id`)
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

/**
 * Run migrations from embedded content (for use in edge functions without filesystem access).
 * This is compatible with pg-node-migrations table format.
 */
export async function runMigrationsFromContent(
  config: MigrationConfig,
  migrations: EmbeddedMigration[]
): Promise<void> {
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    connectionTimeoutMillis: 10_000,
  })

  const schema = 'stripe'
  const tableName = '_migrations'

  try {
    config.logger?.info('Starting migrations (from embedded content)')
    await client.connect()
    config.logger?.info('Connected to database')

    // Ensure schema exists
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema};`)

    // Rename old migrations table if it exists (one-time upgrade)
    await renameMigrationsTableIfNeeded(client, schema, config.logger)

    // Check if migrations table is empty and cleanup if needed
    const tableExists = await doesTableExist(client, schema, tableName)
    if (tableExists) {
      const migrationCount = await client.query(`SELECT COUNT(*) as count FROM "${schema}"."${tableName}"`)
      const isEmpty = migrationCount.rows[0]?.count === '0'
      if (isEmpty) {
        await cleanupSchema(client, schema, config.logger)
      }
    }

    // Ensure migrations table exists
    await ensureMigrationsTable(client, schema, tableName)

    // Get applied migrations
    const appliedMigrations = await getAppliedMigrations(client, schema, tableName)
    const appliedIds = new Set(appliedMigrations.map((m) => m.id))

    // Validate hashes of applied migrations match
    const parsedMigrations = parseMigrations(migrations)
    for (const applied of appliedMigrations) {
      const intended = parsedMigrations.find((m) => m.id === applied.id)
      if (intended && intended.hash !== applied.hash) {
        throw new Error(
          `Migration hash mismatch for ${applied.name}: ` +
            `expected ${intended.hash}, got ${applied.hash}. ` +
            `Migrations cannot be modified after being applied.`
        )
      }
    }

    // Run pending migrations
    const pendingMigrations = parsedMigrations.filter((m) => !appliedIds.has(m.id))
    if (pendingMigrations.length === 0) {
      config.logger?.info('No migrations to run')
    } else {
      config.logger?.info(`Running ${pendingMigrations.length} migration(s)`)
      for (const migration of pendingMigrations) {
        await runMigration(client, schema, tableName, migration, config.logger)
      }
      config.logger?.info(`Successfully applied ${pendingMigrations.length} migration(s)`)
    }
  } catch (err) {
    config.logger?.error(err, 'Error running migrations')
    throw err
  } finally {
    await client.end()
    config.logger?.info('Finished migrations')
  }
}
