// Schemas and derived types
export {
  StreamConfigSchema,
  SyncStatusSchema,
  UpdateCredentialSchema,
  LogEntrySchema,
  buildSchemas,
} from './schemas.js'
export type { Credential, SyncConfig, LogEntry } from './schemas.js'

// Store interfaces
export type { CredentialStore, ConfigStore, StateStore, LogSink } from './stores.js'

// Service
export { StatefulSync, resolve } from './service.js'
export type { StatefulSyncOptions } from './service.js'

// Store implementations
export {
  memoryCredentialStore,
  memoryConfigStore,
  memoryStateStore,
  memoryLogSink,
} from './stores/memory.js'
export { fileCredentialStore, fileConfigStore, fileStateStore, fileLogSink } from './stores/file.js'
export { stderrLogSink } from './stores/stderr.js'
