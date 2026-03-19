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
