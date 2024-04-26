import { Client } from 'pg'
import { migrate } from 'pg-node-migrations'
import { getConfig } from './config'
import fs from 'node:fs'

const config = getConfig()

async function connectAndMigrate(client: Client, migrationsDirectory: string, logOnError = false) {
  if (!fs.existsSync(migrationsDirectory)) {
    console.log(`Migrations directory ${migrationsDirectory} not found, skipping`)
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

export async function runMigrations(client: Client): Promise<void> {
  try {
    console.log('Running migrations')
    await connectAndMigrate(client, './db/migrations')
  } catch (error) {
    throw error
  } finally {
    console.log('Finished migrations')
  }
}
