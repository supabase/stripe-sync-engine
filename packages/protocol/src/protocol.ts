// Sync Engine — Protocol
//
// Zod schemas and inferred types for the sync protocol. Data shapes (messages,
// catalog, config) are runtime-validatable via Zod. Source and Destination
// contracts remain as TS interfaces (generic, method-bearing).

import { z } from 'zod'

// MARK: - Data model

/** A named collection of records — analogous to a table or API resource. */
export const Stream = z.object({
  /** Collection name (e.g. "customers", "invoices", "pg_public.users"). */
  name: z.string(),

  /**
   * Paths to fields that uniquely identify a record within this stream.
   * Supports composite keys and nested paths.
   * e.g. [["id"]] or [["account_id"], ["created"]]
   */
  primary_key: z.array(z.array(z.string())),

  /** JSON Schema describing the record shape. Discovered at runtime or provided by config. */
  json_schema: z.record(z.string(), z.unknown()).optional(),

  /**
   * Source-specific metadata that applies to every record in this stream.
   * The destination can use these for schema naming, partitioning, etc.
   *
   * Examples:
   *   Stripe source:    { api_version: "2025-04-30.basil", account_id: "acct_123", live_mode: true }
   *   Metronome source: { account_id: "met_456" }
   *   Postgres source:  { schema: "public", database: "mydb" }
   */
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type Stream = z.infer<typeof Stream>

// MARK: - Configured catalog

/** A stream selected by the user with sync settings applied. */
export const ConfiguredStream = z.object({
  stream: Stream,

  /** How the source reads this stream. */
  sync_mode: z.enum(['full_refresh', 'incremental']),

  /** How the destination writes this stream. */
  destination_sync_mode: z.enum(['append', 'overwrite', 'append_dedup']),

  /** Field path used as the cursor for incremental syncs. */
  cursor_field: z.array(z.string()).optional(),

  /** Extra system columns the destination should add to this stream's table. */
  system_columns: z
    .array(
      z.object({
        /** Column name, e.g. "_account_id". */
        name: z.string(),
        /** Postgres type, e.g. "text". */
        type: z.string().default('text'),
        /** Whether to create an index on this column. */
        index: z.boolean().default(false),
      })
    )
    .optional(),
})
export type ConfiguredStream = z.infer<typeof ConfiguredStream>

/**
 * The user's selected and configured streams.
 * Persisted on the Sync resource. Passed to read() and write().
 */
export const ConfiguredCatalog = z.object({
  streams: z.array(ConfiguredStream),
})
export type ConfiguredCatalog = z.infer<typeof ConfiguredCatalog>

// MARK: - Connector specification

/** JSON Schema describing the configuration a connector requires. */
export const ConnectorSpecification = z.object({
  /** JSON Schema for the connector's configuration object. */
  config: z.record(z.string(), z.unknown()),
  /** JSON Schema for per-stream state (cursor/checkpoint shape). */
  stream_state: z.record(z.string(), z.unknown()).optional(),
  /** JSON Schema for the read() input parameter (e.g. a webhook event). */
  input: z.record(z.string(), z.unknown()).optional(),
})
export type ConnectorSpecification = z.infer<typeof ConnectorSpecification>

/** Result of a connection check. */
export const CheckResult = z.object({
  status: z.enum(['succeeded', 'failed']),
  message: z.string().optional(),
})
export type CheckResult = z.infer<typeof CheckResult>

// MARK: - Messages

/** One record for one stream. */
export const RecordMessage = z.object({
  type: z.literal('record'),
  /** The stream this record belongs to. */
  stream: z.string(),
  /** Record payload. Schema varies by stream. */
  data: z.record(z.string(), z.unknown()),
  /** When this record was emitted by the source (epoch ms). */
  emitted_at: z.number(),
})
export type RecordMessage = z.infer<typeof RecordMessage>

/**
 * Per-stream checkpoint for resumable syncs.
 *
 * The `stream` field tells the orchestrator which stream is being checkpointed.
 * The `data` field is opaque — only the source understands its contents.
 * The orchestrator persists state keyed by (sync_id, stream) and passes the
 * full map back to the source on resume.
 */
export const StateMessage = z.object({
  type: z.literal('state'),
  /** Which stream this checkpoint is for. */
  stream: z.string(),
  /** Opaque cursor data. Only the source reads/writes this. */
  data: z.unknown(),
})
export type StateMessage = z.infer<typeof StateMessage>

/** Catalog of available streams. Emitted by a source during discover(). */
export const CatalogMessage = z.object({
  type: z.literal('catalog'),
  streams: z.array(Stream),
})
export type CatalogMessage = z.infer<typeof CatalogMessage>

/** Structured log output from a source or destination. */
export const LogMessage = z.object({
  type: z.literal('log'),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
})
export type LogMessage = z.infer<typeof LogMessage>

/**
 * Structured error from a source or destination.
 * failure_type lets the orchestrator decide whether to retry, alert, or abort.
 */
export const ErrorMessage = z.object({
  type: z.literal('error'),
  failure_type: z.enum(['config_error', 'system_error', 'transient_error', 'auth_error']),
  message: z.string(),
  /** The stream this error is about, if applicable. */
  stream: z.string().optional(),
  stack_trace: z.string().optional(),
})
export type ErrorMessage = z.infer<typeof ErrorMessage>

/**
 * Per-stream status update from a source.
 * Enables progress reporting in CLI / dashboard.
 */
export const StreamStatusMessage = z.object({
  type: z.literal('stream_status'),
  stream: z.string(),
  status: z.enum(['started', 'running', 'complete', 'incomplete']),
})
export type StreamStatusMessage = z.infer<typeof StreamStatusMessage>

// MARK: - Sync engine params

/** Parameters for a sync engine run — config, catalog selection, and runtime state. */
export const SyncEngineParams = z.object({
  source_config: z.record(z.string(), z.unknown()),
  destination_config: z.record(z.string(), z.unknown()),
  streams: z
    .array(
      z.object({ name: z.string(), sync_mode: z.enum(['incremental', 'full_refresh']).optional() })
    )
    .optional(),
  state: z.record(z.string(), z.unknown()).optional(),
})
export type SyncEngineParams = z.infer<typeof SyncEngineParams>

/** SyncParams adds connector resolution fields on top of engine params. */
export const SyncParams = SyncEngineParams.extend({
  /** Connector specifier for the source (short name, scoped package, or file path). Defaults to 'stripe'. */
  source_name: z.string().optional().default('stripe'),
  /** Connector specifier for the destination (short name, scoped package, or file path). */
  destination_name: z.string(),
})
export type SyncParams = z.infer<typeof SyncParams>

// MARK: - Message unions

/** The subset of messages the destination receives. */
export const DestinationInput = z.discriminatedUnion('type', [RecordMessage, StateMessage])
export type DestinationInput = z.infer<typeof DestinationInput>

/** Messages the destination yields back to the orchestrator. */
export const DestinationOutput = z.discriminatedUnion('type', [
  StateMessage,
  ErrorMessage,
  LogMessage,
])
export type DestinationOutput = z.infer<typeof DestinationOutput>

/** Any message flowing through the engine. One message per line (NDJSON). */
export const Message = z.discriminatedUnion('type', [
  RecordMessage,
  StateMessage,
  CatalogMessage,
  LogMessage,
  ErrorMessage,
  StreamStatusMessage,
])
export type Message = z.infer<typeof Message>

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
  read(
    params: {
      config: TConfig
      catalog: ConfiguredCatalog
      state?: Record<string, TStreamState>
    },
    $stdin?: AsyncIterable<TInput>
  ): AsyncIterable<Message>

  /** Provision external resources (webhook endpoints, replication slots, etc.). Called before first read(). */
  setup?(params: { config: TConfig; catalog: ConfiguredCatalog }): Promise<void>

  /** Clean up external resources. Called when a sync is deleted. */
  teardown?(params: { config: TConfig; remove_shared_resources?: boolean }): Promise<void>
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
    $stdin: AsyncIterable<DestinationInput>
  ): AsyncIterable<DestinationOutput>

  /** Provision downstream resources (schemas, tables, etc.). Called before first write(). */
  setup?(params: { config: TConfig; catalog: ConfiguredCatalog }): Promise<void>

  /** Clean up downstream resources. Called when a sync is deleted. */
  teardown?(params: { config: TConfig; remove_shared_resources?: boolean }): Promise<void>
}
