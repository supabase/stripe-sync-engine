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
