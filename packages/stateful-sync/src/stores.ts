// Store interfaces for stateful sync.
// Types (Credential, SyncConfig, LogEntry) are defined in ./schemas.

import type { Credential, SyncConfig, LogEntry } from './schemas.js'

export type { Credential, SyncConfig, LogEntry }

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

export interface StateStore {
  get(syncId: string): Promise<Record<string, unknown> | undefined>
  set(syncId: string, stream: string, data: unknown): Promise<void>
  clear(syncId: string): Promise<void>
}

export interface LogSink {
  /** Fire-and-forget, non-blocking. */
  write(syncId: string, entry: LogEntry): void
}
