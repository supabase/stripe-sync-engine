// Sync Engine — Protocol
//
// Types and interfaces for the sync protocol. Data shapes (messages, catalog,
// config) followed by the Source and Destination contracts that connectors
// implement.

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

// MARK: - Source
//
// In-process sources implement this interface directly.
// Subprocess sources read/write NDJSON on stdin/stdout and a thin
// adapter converts between the two.

/**
 * Reads data from an upstream system by emitting messages.
 *
 * A source can be finite (backfill) or infinite (live/streaming).
 * The same interface covers REST API polling, webhook ingestion,
 * event bridge, Kafka replay, database CDC, etc.
 *
 * Type parameters:
 *   TConfig      — connector's configuration type, inferred from its Zod spec
 *   TStreamState — per-stream checkpoint shape (opaque to the orchestrator)
 *   TInput       — serializable data passed to read() for event-driven reads
 *                  (e.g. a single webhook event). When absent, read() performs
 *                  a pull-based backfill.
 *
 * Subprocess equivalent:
 *   discover -> run source process, collect CatalogMessage from stdout
 *   read    -> run source process, stream Message lines from stdout
 */
export interface Source<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TStreamState = unknown,
  TInput = unknown,
> {
  /** Return the JSON Schema for this connector's configuration. */
  spec(): ConnectorSpecification

  /** Validate that the provided configuration can connect to the upstream system. */
  check(params: { config: TConfig }): Promise<CheckResult>

  /** Discover available streams. Returns them as a CatalogMessage. */
  discover(params: { config: TConfig }): Promise<CatalogMessage>

  /** Emit messages (record, state, log, error, stream_status). Finite for backfill, infinite for live. */
  read(params: {
    config: TConfig
    catalog: ConfiguredCatalog
    state?: Record<string, TStreamState>
    input?: TInput
  }): AsyncIterable<Message>

  /** Provision external resources (webhook endpoints, replication slots, etc.). Called before first read(). */
  setup?(params: { config: TConfig; catalog: ConfiguredCatalog }): Promise<void>

  /** Clean up external resources. Called when a sync is deleted. */
  teardown?(params: { config: TConfig }): Promise<void>
}

// MARK: - Destination
//
// In-process destinations implement this interface directly.
// Subprocess destinations read DestinationInputs from stdin and emit
// DestinationOutput on stdout after committing.

/**
 * Writes records into a downstream system.
 *
 * A destination can be a database, spreadsheet, warehouse, Stripe API
 * (e.g. Custom Objects for reverse ETL), Kafka topic, etc.
 *
 * TConfig is the connector's configuration type, inferred from its Zod spec.
 *
 * The destination only receives RecordMessage and StateMessage -- the
 * orchestrator filters out logs, errors, and status messages before
 * they reach the destination.
 *
 * Subprocess equivalent:
 *   destination write --config config.json --catalog catalog.json
 *   Reads DestinationInput lines from stdin, emits DestinationOutput on stdout.
 */
export interface Destination<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  /** Return the JSON Schema for this connector's configuration. */
  spec(): ConnectorSpecification

  /** Validate that the provided configuration can connect to the downstream system. */
  check(params: { config: TConfig }): Promise<CheckResult>

  /**
   * Consume data messages and write records to the downstream system.
   * Yields messages back to the orchestrator: StateMessage after committing,
   * ErrorMessage on write failures, LogMessage for diagnostics.
   */
  write(
    params: { config: TConfig; catalog: ConfiguredCatalog },
    messages: AsyncIterable<DestinationInput>
  ): AsyncIterable<DestinationOutput>

  /** Provision downstream resources (schemas, tables, etc.). Called before first write(). */
  setup?(params: { config: TConfig; catalog: ConfiguredCatalog }): Promise<void>

  /** Clean up downstream resources. Called when a sync is deleted. */
  teardown?(params: { config: TConfig }): Promise<void>
}
