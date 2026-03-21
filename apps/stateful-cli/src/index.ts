// Re-export sync-service types and service for programmatic consumers
export type {
  Credential,
  SyncConfig,
  LogEntry,
  CredentialStore,
  ConfigStore,
  StateStore,
  LogSink,
  SyncServiceOptions,
} from '@stripe/stateful-sync'

export { SyncService, resolve } from '@stripe/stateful-sync'
