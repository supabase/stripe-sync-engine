// CLI
export type { DestinationCliOptions } from './cli'
export { main as cliMain } from './cli'

export type { DestinationWriter } from './destinationWriter'
export { PostgresDestination } from './postgresDestination'
export { PostgresDestinationWriter } from './writer'
export { QueryUtils, type InsertColumn } from './QueryUtils'
export { METADATA_TABLES, type PostgresConfig, type RawJsonUpsertOptions } from './types'

// OpenAPI spec → DDL
export type * from './openapi/types'
export {
  SpecParser,
  RUNTIME_REQUIRED_TABLES,
  OPENAPI_RESOURCE_TABLE_ALIASES,
  RUNTIME_RESOURCE_ALIASES,
} from './openapi/specParser'
export { OPENAPI_COMPATIBILITY_COLUMNS } from './openapi/runtimeMappings'
export { PostgresAdapter } from './openapi/postgresAdapter'
export { WritePathPlanner } from './openapi/writePathPlanner'
export { resolveOpenApiSpec } from './openapi/specFetchHelper'
export type { DialectAdapter } from './openapi/dialectAdapter'

// Migrations
export { runMigrations, runMigrationsFromContent } from './database/migrate'
export type { MigrationConfig } from './database/migrate'
export { embeddedMigrations } from './database/migrations-embedded'
export type { EmbeddedMigration } from './database/migrations-embedded'
export { renderMigrationTemplate } from './database/migrationTemplate'
