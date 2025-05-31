import 'dotenv/config'
import { Client } from 'pg'
import { migrate } from 'pg-node-migrations'
import { getConfig } from './config'
import fs from 'node:fs'
import { logger } from '../logger'

const config = getConfig()

async function connectAndMigrate(client: Client, migrationsDirectory: string, logOnError = false) {
  if (!fs.existsSync(migrationsDirectory)) {
    logger.info(`Migrations directory ${migrationsDirectory} not found, skipping`)
    return
  }

  const optionalConfig = {
    schemaName: config.SCHEMA,
    tableName: 'migrations',
  }

  try {
    await migrate({ client }, migrationsDirectory, optionalConfig)
  } catch (error) {
    if (logOnError && error instanceof Error) {
      console.error('Migration error:', error.message)
    } else {
      throw error
    }
  }
}

export async function runMigrations(): Promise<void> {
  // Init DB
  const dbConfig = {
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 10_000,
  }
  const client = new Client(dbConfig)

  try {
    // Run migrations
    await client.connect()

    // Ensure schema exists, not doing it via migration to not break current migration checksums
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${config.SCHEMA};`)

    logger.info('Running migrations')

    await connectAndMigrate(client, './db/migrations')
  } catch (err) {
    logger.error(err, 'Error running migrations')
  } finally {
    await client.end()
    logger.info('Finished migrations')
  }
}
