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
export type { StateStore } from '@stripe/sync-engine'

// File-system store implementations
export {
  fileCredentialStore,
  fileConfigStore,
  fileStateStore,
  fileLogSink,
} from './lib/stores-fs.js'

// Resolution
export { resolve } from './lib/resolve.js'

// Service
export { SyncService } from './lib/service.js'
export type { SyncServiceOptions } from './lib/service.js'

// API app factory
export { createApp } from './api/app.js'
export type { AppOptions } from './api/app.js'
