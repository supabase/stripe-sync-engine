export { VERSION } from './version'

export { StripeSync } from './stripeSync'
export { StripeSyncWorker } from './stripeSyncWorker'
export type { WorkerTaskManager } from './stripeSyncWorker'
export type { DestinationWriter } from '@stripe/destination-postgres'
export { getTableName } from './resourceRegistry'

export type * from './types'
export type * from './protocol'

export { PostgresClient } from './database/postgres'
export { runMigrations, runMigrationsFromContent } from './database/migrate'
export { embeddedMigrations } from './database/migrations-embedded'
export type { EmbeddedMigration } from './database/migrations-embedded'
export { hashApiKey } from './utils/hashApiKey'
export {
  parseSchemaComment,
  type StripeSchemaComment,
  type SchemaInstallationStatus,
} from './supabase/schemaComment'
export { createStripeWebSocketClient } from './websocket-client'
export type {
  StripeWebSocketOptions,
  StripeWebSocketClient,
  StripeWebhookEvent,
  WebhookProcessingResult,
} from './websocket-client'

// Sub-package re-exports (composition root surface)
export { catalogFromRegistry, expandEntity } from '@stripe/source-stripe'

export {
  PostgresDestinationWriter,
  QueryUtils,
  METADATA_TABLES,
} from '@stripe/destination-postgres'

export type {
  PostgresConfig,
  RawJsonUpsertOptions,
  InsertColumn,
} from '@stripe/destination-postgres'

export { SheetsDestination, type SheetsDestinationConfig } from '@stripe/destination-google-sheets'

export {
  PostgresOrchestrator,
  PostgresStateManager,
  forward,
  collect,
} from '@stripe/orchestrator-postgres'

export type { Sync, StateManagerConfig, RouterCallbacks } from '@stripe/orchestrator-postgres'

export { runPipeline } from './pipeline'
export type { PipelineOrchestrator } from './pipeline'
