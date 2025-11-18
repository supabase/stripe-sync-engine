import { Client } from 'pg'
import { migrate } from 'pg-node-migrations'
import fs from 'node:fs'
import pino from 'pino'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConnectionOptions } from 'node:tls'

// Get __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

type MigrationConfig = {
  schema: string
  databaseUrl: string
  ssl?: ConnectionOptions
  logger?: pino.Logger
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
  schema: string,
  logger?: pino.Logger
): Promise<void> {
  const oldTableExists = await doesTableExist(client, schema, 'migrations')
  const newTableExists = await doesTableExist(client, schema, '_migrations')

  if (oldTableExists && !newTableExists) {
    logger?.info('Renaming migrations table to _migrations')
    await client.query(`ALTER TABLE "${schema}"."migrations" RENAME TO "_migrations"`)
    logger?.info('Successfully renamed migrations table')
  }
}

async function connectAndMigrate(
  client: Client,
  migrationsDirectory: string,
  config: MigrationConfig,
  logOnError = false
) {
  if (!fs.existsSync(migrationsDirectory)) {
    config.logger?.info(`Migrations directory ${migrationsDirectory} not found, skipping`)
    return
  }

  const optionalConfig = {
    schemaName: config.schema,
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

  try {
    // Run migrations
    await client.connect()

    // Ensure schema exists, not doing it via migration to not break current migration checksums
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${config.schema};`)

    // Rename old migrations table if it exists (one-time upgrade to internal table naming convention)
    await renameMigrationsTableIfNeeded(client, config.schema, config.logger)

    config.logger?.info('Running migrations')

    await connectAndMigrate(client, path.resolve(__dirname, './migrations'), config)
  } catch (err) {
    config.logger?.error(err, 'Error running migrations')
    throw err
  } finally {
    await client.end()
    config.logger?.info('Finished migrations')
  }
}
