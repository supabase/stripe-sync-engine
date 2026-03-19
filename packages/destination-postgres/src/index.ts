import { z } from 'zod'
import type { Destination } from '@stripe/sync-protocol'
import { PostgresDestination } from './postgresDestination'

// MARK: - Spec

export const spec = z.object({
  connection_string: z.string().describe('Postgres connection string'),
  schema: z.string().default('stripe').describe('Target schema name'),
  batch_size: z.number().default(100).describe('Records to buffer before flushing'),
})

export type Config = z.infer<typeof spec>

// MARK: - Named exports

// CLI
export type { DestinationCliOptions } from './cli'
export { main as cliMain } from './cli'

export type { DestinationWriter } from './destinationWriter'
export { PostgresDestination } from './postgresDestination'
export { PostgresDestinationWriter } from './writer'
export { QueryUtils, type InsertColumn } from './QueryUtils'
export { METADATA_TABLES, type PostgresConfig, type RawJsonUpsertOptions } from './types'

// Migrations
export { runMigrations, runMigrationsFromContent } from './database/migrate'
export type { MigrationConfig } from './database/migrate'
export { embeddedMigrations } from './database/migrations-embedded'
export type { EmbeddedMigration } from './database/migrations-embedded'
export { renderMigrationTemplate } from './database/migrationTemplate'

// MARK: - Default export

const destination = {
  spec() {
    return { config: z.toJSONSchema(spec) }
  },

  async check({ config }) {
    const dest = new PostgresDestination({
      schema: config.schema ?? 'stripe',
      poolConfig: { connectionString: config.connection_string },
    })
    return dest.check({ config })
  },

  async setup({ config, catalog }) {
    const dest = new PostgresDestination({
      schema: config.schema ?? 'stripe',
      poolConfig: { connectionString: config.connection_string },
    })
    await dest.setup({ config, catalog })
  },

  async teardown({ config }) {
    const dest = new PostgresDestination({
      schema: config.schema ?? 'stripe',
      poolConfig: { connectionString: config.connection_string },
    })
    await dest.teardown({ config })
  },

  async *write({ config, catalog, messages }) {
    const dest = new PostgresDestination({
      schema: config.schema ?? 'stripe',
      poolConfig: { connectionString: config.connection_string },
      batchSize: config.batch_size,
    })
    yield* dest.write({ config, catalog, messages })
  },
} satisfies Destination<Config>

export default destination
