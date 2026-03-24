// Re-export sync-service types and service for programmatic consumers
export type {
  Credential,
  SyncConfig,
  LogEntry,
  CredentialStore,
  ConfigStore,
  StateStore,
  LogSink,
  StatefulSyncOptions,
} from '@stripe/stateful-sync'

export { StatefulSync, resolve } from '@stripe/stateful-sync'
export { createApp } from './api/app'
export type { AppOptions } from './api/app'
