import { Client } from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from 'pino'
import type { ConnectionOptions } from 'node:tls'

type MigrationConfig = {
  schema: string
  databaseUrl: string
  ssl?: ConnectionOptions
  logger?: Logger
}

const MIGRATION_LOCK_ID = 72987329
const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

function parseFileName(fileName: string): { id: number; name: string } | null {
  const match = /^(\d+)[-_](.*)\.sql$/i.exec(fileName)
  if (!match) return null
  return { id: parseInt(match[1], 10), name: match[2] }
}

export type Migration = { id: number; name: string; sql: string }

/**
 * Returns all migrations with schema placeholders replaced.
 * Useful for inspecting migrations or running them manually with psql.
 */
export function getMigrations(config: { schema?: string } = {}): Migration[] {
  const schema = config.schema ?? 'stripe'

  if (!fs.existsSync(MIGRATIONS_DIR)) return []

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((fileName) => {
      const parsed = parseFileName(fileName)
      if (!parsed) return null

      const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, fileName), 'utf8')
      const sql = raw.replace(/\{\{schema\}\}/g, schema)

      return { id: parsed.id, name: parsed.name, sql }
    })
    .filter((m): m is Migration => m !== null)
}

/**
 * Applies a single migration file within a transaction.
 * Supports disabling transactions via `-- postgres-migrations disable-transaction` comment.
 */
async function applyMigration(
  client: Client,
  tableName: string,
  migration: { id: number; name: string; sql: string }
): Promise<void> {
  const useTransaction = !migration.sql.includes('-- postgres-migrations disable-transaction')

  try {
    if (useTransaction) await client.query('START TRANSACTION')
    await client.query(migration.sql)
    await client.query(`INSERT INTO ${tableName} (id, name) VALUES ($1, $2)`, [
      migration.id,
      migration.name,
    ])
    if (useTransaction) await client.query('COMMIT')
  } catch (err) {
    if (useTransaction) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Connection may already be broken
      }
    }
    throw new Error(
      `Migration ${migration.id} (${migration.name}) failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export async function runMigrations(config: MigrationConfig): Promise<void> {
  const client = new Client({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    connectionTimeoutMillis: 10_000,
  })

  const migrationsTableName = `"${config.schema}"."migrations"`
  const migrations = getMigrations({ schema: config.schema })

  try {
    await client.connect()

    if (migrations.length === 0) {
      config.logger?.info(`No migrations found, skipping`)
      return
    }

    config.logger?.info('Running migrations')

    await client.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`)

    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`)

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${migrationsTableName} (
          id integer PRIMARY KEY,
          name varchar(100) UNIQUE NOT NULL,
          executed_at timestamp DEFAULT current_timestamp
        )
      `)

      const { rows: applied } = await client.query<{ id: number }>(
        `SELECT id FROM ${migrationsTableName}`
      )
      const appliedIds = new Set(applied.map((r) => r.id))

      for (const migration of migrations) {
        if (appliedIds.has(migration.id)) continue

        config.logger?.info(`Applying migration ${migration.id}: ${migration.name}`)
        await applyMigration(client, migrationsTableName, migration)
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`)
    }

    config.logger?.info('Finished migrations')
  } catch (err) {
    config.logger?.error(err, 'Error running migrations')
    throw err
  } finally {
    await client.end()
  }
}
