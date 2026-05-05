// Sync Engine — Message Protocol
//
// Everything is a Message, one per line (NDJSON). These types define
// the data structures that flow through the engine. For the interfaces
// that sources, destinations, and the orchestrator implement, see
// sync-engine-api.ts.

// MARK: - Data model

/** A named collection of records — analogous to a table or API resource. */
export interface Stream {
  /** Collection name (e.g. "customer", "invoice", "pg_public.user"). */
  name: string

  /**
   * Paths to fields that uniquely identify a record within this stream.
   * Supports composite keys and nested paths.
   * e.g. [["id"]] or [["account_id"], ["created"]]
   */
  primary_key: string[][]

  /** JSON Schema describing the record shape. Discovered at runtime or provided by config. */
  json_schema?: Record<string, unknown>

  /**
   * Source-specific metadata that applies to every record in this stream.
   * The destination can use these for schema naming, partitioning, etc.
   *
   * Examples:
   *   Stripe source:    { api_version: "2025-04-30.basil", account_id: "acct_123", live_mode: true }
   *   Other source:     { account_id: "ext_456" }
   *   Postgres source:  { schema: "public", database: "mydb" }
   */
  metadata?: Record<string, unknown>
}

// MARK: - Messages

/** One record for one stream. */
export interface RecordMessage {
  type: 'record'
  /** The stream this record belongs to. */
  stream: string
  /** Record payload. Schema varies by stream. */
  data: Readonly<Record<string, unknown>>
  /** When this record was emitted by the source (ISO 8601). */
  emitted_at: string
}

/**
 * Per-stream checkpoint for resumable syncs.
 *
 * The `stream` field tells the orchestrator which stream is being checkpointed.
 * The `data` field is opaque — only the source understands its contents.
 * The orchestrator persists state keyed by (sync_id, stream) and passes the
 * full map back to the source on resume.
 */
export interface SourceStateMessage {
  type: 'source_state'
  /** Which stream this checkpoint is for. */
  stream: string
  /** Opaque cursor data. Only the source reads/writes this. */
  data: unknown
}

/** @deprecated Use SourceStateMessage */
export type StateMessage = SourceStateMessage

/** Catalog of available streams. Emitted by a source during discovery. */
export interface CatalogMessage {
  type: 'catalog'
  streams: Stream[]
}

/** Structured log output from a source or destination. */
export interface LogMessage {
  type: 'log'
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}

/**
 * Structured error from a source or destination.
 * failure_type lets the orchestrator decide whether to retry, alert, or abort.
 */
export interface ErrorMessage {
  type: 'error'
  failure_type: 'config_error' | 'system_error' | 'transient_error'
  message: string
  /** The stream this error is about, if applicable. */
  stream?: string
  stack_trace?: string
}

/**
 * Per-stream status update from a source.
 * Enables progress reporting in CLI / dashboard.
 */
export interface StreamStatusMessage {
  type: 'stream_status'
  stream: string
  status: 'started' | 'running' | 'complete' | 'range_complete'
}

// MARK: - Message unions

/** The subset of messages the destination receives. */
export type DestinationInput = RecordMessage | SourceStateMessage

/** Messages the destination yields back to the orchestrator. */
export type DestinationOutput = SourceStateMessage | ErrorMessage | LogMessage

/** Any message flowing through the engine. One message per line (NDJSON). */
export type Message =
  | RecordMessage
  | SourceStateMessage
  | CatalogMessage
  | LogMessage
  | ErrorMessage
  | StreamStatusMessage
