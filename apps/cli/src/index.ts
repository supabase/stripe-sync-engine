export { VERSION } from './version'

export { StripeSync } from './stripeSync'
export type { RunKey } from './stripeSync'

// Re-export from sub-packages for backward compatibility
export { StripeSyncWorker, type WorkerTaskManager } from '@stripe/source-stripe'
export type { DestinationWriter } from '@stripe/destination-postgres'
export { getTableName } from '@stripe/source-stripe'

export type * from './types'
export type * from '@stripe/sync-protocol'

export { PostgresClient } from './database/postgres'
export { runMigrations, runMigrationsFromContent } from '@stripe/destination-postgres'
export { embeddedMigrations } from '@stripe/destination-postgres'
export type { EmbeddedMigration } from '@stripe/destination-postgres'
export { hashApiKey } from '@stripe/source-stripe'
export {
  parseSchemaComment,
  type StripeSchemaComment,
  type SchemaInstallationStatus,
} from '@stripe/integration-supabase'
export { createStripeWebSocketClient } from '@stripe/source-stripe'
export type {
  StripeWebSocketOptions,
  StripeWebSocketClient,
  StripeWebhookEvent,
  WebhookProcessingResult,
} from '@stripe/source-stripe'

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

export { runPipeline } from '@stripe/orchestrator-postgres'
export type { PipelineOrchestrator } from '@stripe/orchestrator-postgres'
