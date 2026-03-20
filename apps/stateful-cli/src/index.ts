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
} from '@stripe/sync-service'

export { SyncService, resolve } from '@stripe/sync-service'
