// Store interfaces and types for stateful sync.
// Plain TS — no Zod, no runtime validation. These are internal contracts.

/** A stored credential — flat shape, type-specific fields at top level. */
export type Credential = {
  id: string
  /** Credential type — e.g. "stripe", "postgres", "google". */
  type: string
  created_at: string
  updated_at: string
  /** Type-specific fields (api_key, connection_string, etc.) at top level. */
  [key: string]: unknown
}

/**
 * Stored form of a sync configuration. References credentials by ID,
 * does not contain state. Resolved to SyncParams before calling the engine.
 */
export type SyncConfig = {
  id: string
  /** Account identifier — optional, set by the API layer. */
  account_id?: string
  /** Sync status — optional, set by the API layer. */
  status?: string
  source: {
    type: string
    credential_id: string
    [key: string]: unknown
  }
  destination: {
    type: string
    credential_id: string
    [key: string]: unknown
  }
  streams?: Array<{ name: string; sync_mode?: 'incremental' | 'full_refresh' }>
}

/** Structured log entry written by the service during sync runs. */
export type LogEntry = {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  stream?: string
  timestamp: string
}

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
