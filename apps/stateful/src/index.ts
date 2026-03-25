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
} from '@stripe/sync-lib-stateful'

export { StatefulSync, resolve } from '@stripe/sync-lib-stateful'
export { createApp } from './api/app.js'
export type { AppOptions } from './api/app.js'
