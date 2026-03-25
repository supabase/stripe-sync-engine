// Barrel — re-exports for consumers of @stripe/sync-service

// Schemas (Zod + inferred types)
export {
  Credential,
  CreateCredential,
  UpdateCredential,
  SourceConfig,
  DestinationConfig,
  StreamConfig,
  SyncConfig,
  CreateSync,
  UpdateSync,
  LogEntry,
} from './lib/schemas.js'

// Store interfaces
export type { CredentialStore, ConfigStore, LogSink } from './lib/stores.js'
export type { StateStore } from './lib/stores.js'

// File-system store implementations
export {
  fileCredentialStore,
  fileConfigStore,
  fileStateStore,
  fileLogSink,
} from './lib/stores-fs.js'

// Resolution
export { resolve, resolveCredentials } from './lib/resolve.js'

// Service
export { SyncService } from './lib/service.js'
export type { SyncServiceOptions } from './lib/service.js'

// Temporal bridge
export { TemporalBridge } from './temporal/bridge.js'
export type { TemporalOptions } from './temporal/bridge.js'

// API app factory
export { createApp } from './api/app.js'
export type { AppOptions } from './api/app.js'

// Temporal workflow types (for consumers that need to reference them)
export type { RunResult, SyncActivities, WorkflowStatus } from './temporal/types.js'
export { createActivities } from './temporal/activities.js'
export { createWorker } from './temporal/worker.js'
export type { WorkerOptions } from './temporal/worker.js'
