import { Client } from 'pg'
import { migrate } from 'pg-node-migrations'
import { getConfig } from './config'

const config = getConfig()

async function connectAndMigrate(
  databaseUrl: string | undefined,
  migrationsDirectory: string,
  logOnError = false
) {
  const dbConfig = {
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1000,
  }
  const optionalConfig = {
    schemaName: config.SCHEMA,
    tableName: 'migrations',
  }

  const client = new Client(dbConfig)
  try {
    await client.connect()
    await migrate({ client }, migrationsDirectory, optionalConfig)
  } catch (error) {
    if (logOnError && error instanceof Error) {
      console.error('Migration error:', error.message)
    } else {
      throw error
    }
  } finally {
    await client.end()
  }
}

export async function runMigrations(): Promise<void> {
  try {
    console.log('Running migrations')
    await connectAndMigrate(config.DATABASE_URL, './db/migrations')
  } catch (error) {
    throw error
  } finally {
    console.log('Finished migrations')
  }
}
