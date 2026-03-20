// Types and interfaces
export type { Credential, SyncConfig, LogEntry } from './stores'
export type { CredentialStore, ConfigStore, StateStore, LogSink } from './stores'

// Service
export { SyncService, resolve } from './service'
export type { SyncServiceOptions } from './service'

// Store implementations
export {
  memoryCredentialStore,
  memoryConfigStore,
  memoryStateStore,
  memoryLogSink,
} from './stores/memory'
export { fileCredentialStore, fileConfigStore, fileStateStore, fileLogSink } from './stores/file'
export { envCredentialStore, flagConfigStore } from './stores/env'
export { stderrLogSink } from './stores/stderr'

export type {
  SyncStatus,
  StreamConfig,
  StripeApiCoreSource,
  SourceConfig,
  PostgresDestination,
  DestinationConfig,
} from './syncTypes'
export type { Sync as SyncResource } from './syncTypes'
export { syncFromBridgeInput, type SyncBridgeInput } from './bridge'

// Migrations (absorbed from packages/destination-postgres/src/database)
export { runMigrations, runMigrationsFromContent } from './database/migrate'
export type { MigrationConfig } from './database/migrate'
export { embeddedMigrations, genericBootstrapMigrations } from './database/migrations-embedded'
export type { EmbeddedMigration } from './database/migrations-embedded'
export { renderMigrationTemplate } from './database/migrationTemplate'
