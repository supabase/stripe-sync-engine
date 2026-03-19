// Sync Engine — Message Protocol
//
// Everything is a Message, one per line (NDJSON). These types define
// the data structures that flow through the engine. For the interfaces
// that sources, destinations, and the orchestrator implement, see
// interfaces.ts.

// MARK: - Data model

/** A named collection of records — analogous to a table or API resource. */
export interface Stream {
  /** Collection name (e.g. "customers", "invoices", "pg_public.users"). */
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
   *   Metronome source: { account_id: "met_456" }
   *   Postgres source:  { schema: "public", database: "mydb" }
   */
  metadata?: Record<string, unknown>
}

// MARK: - Configured catalog

/** A stream selected by the user with sync settings applied. */
export interface ConfiguredStream {
  stream: Stream

  /** How the source reads this stream. */
  sync_mode: 'full_refresh' | 'incremental'

  /** How the destination writes this stream. */
  destination_sync_mode: 'append' | 'overwrite' | 'append_dedup'

  /** Field path used as the cursor for incremental syncs. */
  cursor_field?: string[]
}

/**
 * The user's selected and configured streams.
 * Persisted on the Sync resource. Passed to read() and write().
 */
export interface ConfiguredCatalog {
  streams: ConfiguredStream[]
}

// MARK: - Connector specification

/** JSON Schema describing the configuration a connector requires. */
export interface ConnectorSpecification {
  /** JSON Schema for the connector's configuration object. */
  config: Record<string, unknown>
  /** JSON Schema for per-stream state (cursor/checkpoint shape). */
  stream_state?: Record<string, unknown>
  /** JSON Schema for the read() input parameter (e.g. a webhook event). */
  input?: Record<string, unknown>
}

/** Result of a connection check. */
export interface CheckResult {
  status: 'succeeded' | 'failed'
  message?: string
}

// MARK: - Messages

/** One record for one stream. */
export interface RecordMessage {
  type: 'record'
  /** The stream this record belongs to. */
  stream: string
  /** Record payload. Schema varies by stream. */
  data: Readonly<Record<string, unknown>>
  /** When this record was emitted by the source (epoch ms). */
  emitted_at: number
}

/**
 * Per-stream checkpoint for resumable syncs.
 *
 * The `stream` field tells the orchestrator which stream is being checkpointed.
 * The `data` field is opaque — only the source understands its contents.
 * The orchestrator persists state keyed by (sync_id, stream) and passes the
 * full map back to the source on resume.
 */
export interface StateMessage {
  type: 'state'
  /** Which stream this checkpoint is for. */
  stream: string
  /** Opaque cursor data. Only the source reads/writes this. */
  data: unknown
}

/** Catalog of available streams. Emitted by a source during discover(). */
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
  status: 'started' | 'running' | 'complete' | 'incomplete'
}

// MARK: - Sync config

/** Configuration for a sync run. Passed to `runSync()`. */
export interface SyncConfig {
  source_config: Record<string, unknown>
  destination_config: Record<string, unknown>
  streams?: Array<{ name: string; sync_mode?: 'incremental' | 'full_refresh' }>
  state?: Record<string, unknown>
}

// MARK: - Message unions

/** The subset of messages the destination receives. */
export type DestinationInput = RecordMessage | StateMessage

/** Messages the destination yields back to the orchestrator. */
export type DestinationOutput = StateMessage | ErrorMessage | LogMessage

/** Any message flowing through the engine. One message per line (NDJSON). */
export type Message =
  | RecordMessage
  | StateMessage
  | CatalogMessage
  | LogMessage
  | ErrorMessage
  | StreamStatusMessage
