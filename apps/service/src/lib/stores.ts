import type { Credential, SyncConfig, LogEntry } from './schemas.js'

export type { Credential, SyncConfig, LogEntry }

// Re-export StateStore from the engine
export type { StateStore } from '@stripe/sync-engine'

// MARK: - Store interfaces

export interface CredentialStore {
  get(id: string): Promise<Credential>
  set(id: string, credential: Credential): Promise<void>
  delete(id: string): Promise<void>
  list(): Promise<Credential[]>
}

export interface ConfigStore {
  get(id: string): Promise<SyncConfig>
  set(id: string, config: SyncConfig): Promise<void>
  delete(id: string): Promise<void>
  list(): Promise<SyncConfig[]>
}

export interface LogSink {
  /** Fire-and-forget, non-blocking. */
  write(syncId: string, entry: LogEntry): void
}
