// Sync Engine — Protocol
//
// Zod schemas and inferred types for the sync protocol. Data shapes (messages,
// catalog, config) are runtime-validatable via Zod. Source and Destination
// contracts remain as TS interfaces (generic, method-bearing).

import { z } from 'zod'

// MARK: - Data model

export const Stream = z
  .object({
    name: z.string().describe('Collection name (e.g. "customers", "invoices", "pg_public.users").'),

    primary_key: z
      .array(z.array(z.string()))
      .describe(
        'Paths to fields that uniquely identify a record within this stream. Supports composite keys and nested paths. e.g. [["id"]] or [["account_id"], ["created"]]'
      ),

    json_schema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'JSON Schema describing the record shape. Discovered at runtime or provided by config.'
      ),

    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Source-specific metadata that applies to every record in this stream. The destination can use these for schema naming, partitioning, etc. Examples: Stripe: { api_version, account_id, live_mode }.'
      ),
  })
  .describe('A named collection of records — analogous to a table or API resource.')
export type Stream = z.infer<typeof Stream>

// MARK: - Configured catalog

export const ConfiguredStream = z
  .object({
    stream: Stream,

    sync_mode: z
      .enum(['full_refresh', 'incremental'])
      .describe('How the source reads this stream.'),

    destination_sync_mode: z
      .enum(['append', 'overwrite', 'append_dedup'])
      .describe('How the destination writes this stream.'),

    cursor_field: z
      .array(z.string())
      .optional()
      .describe('Field path used as the cursor for incremental syncs.'),

    system_columns: z
      .array(
        z.object({
          name: z.string().describe('Column name, e.g. "_account_id".'),
          type: z.string().default('text').describe('Postgres type, e.g. "text".'),
          index: z.boolean().default(false).describe('Whether to create an index on this column.'),
        })
      )
      .optional()
      .describe("Extra system columns the destination should add to this stream's table."),

    fields: z
      .array(z.string())
      .optional()
      .describe('If set, only these field names are included in records for this stream.'),

    backfill_limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Cap backfill to this many records, then mark the stream complete.'),
  })
  .describe('A stream selected by the user with sync settings applied.')
export type ConfiguredStream = z.infer<typeof ConfiguredStream>

export const ConfiguredCatalog = z
  .object({
    streams: z.array(ConfiguredStream),
  })
  .describe(
    "The user's selected and configured streams. Persisted on the Sync resource. Passed to read() and write()."
  )
export type ConfiguredCatalog = z.infer<typeof ConfiguredCatalog>

// MARK: - Connector specification

export const ConnectorSpecification = z
  .object({
    config: z
      .record(z.string(), z.unknown())
      .describe("JSON Schema for the connector's configuration object."),
    stream_state: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('JSON Schema for per-stream state (cursor/checkpoint shape).'),
    input: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('JSON Schema for the read() input parameter (e.g. a webhook event).'),
  })
  .describe('JSON Schema describing the configuration a connector requires.')
export type ConnectorSpecification = z.infer<typeof ConnectorSpecification>

export const CheckResult = z
  .object({
    status: z.enum(['succeeded', 'failed']),
    message: z.string().optional().describe('Human-readable explanation of the check result.'),
  })
  .describe('Result of a connection check.')
export type CheckResult = z.infer<typeof CheckResult>

// MARK: - Messages

export const RecordMessage = z
  .object({
    type: z.literal('record'),
    stream: z.string().describe('Stream (table) name this record belongs to.'),
    data: z.record(z.string(), z.unknown()).describe('The record payload as a key-value map.'),
    emitted_at: z
      .string()
      .datetime()
      .describe('ISO 8601 timestamp when the record was emitted by the source.'),
  })
  .describe('One record for one stream.')
  .meta({ id: 'RecordMessage' })
export type RecordMessage = z.infer<typeof RecordMessage>

export const StateMessage = z
  .object({
    type: z.literal('state'),
    stream: z.string().describe('Stream being checkpointed.'),
    data: z
      .unknown()
      .describe(
        'Opaque checkpoint data — only the source understands its contents. The orchestrator persists it keyed by stream and passes it back on resume.'
      ),
  })
  .describe(
    'Per-stream checkpoint for resumable syncs. Emitted by the source after each page/batch so the orchestrator can persist progress.'
  )
  .meta({ id: 'StateMessage' })
export type StateMessage = z.infer<typeof StateMessage>

export const CatalogMessage = z
  .object({
    type: z.literal('catalog'),
    streams: z.array(Stream).describe('All streams available from this source.'),
  })
  .describe('Catalog of available streams. Emitted by a source during discover().')
  .meta({ id: 'CatalogMessage' })
export type CatalogMessage = z.infer<typeof CatalogMessage>

export const LogMessage = z
  .object({
    type: z.literal('log'),
    level: z.enum(['debug', 'info', 'warn', 'error']).describe('Log severity level.'),
    message: z.string().describe('Human-readable log message.'),
  })
  .describe('Structured log output from a source or destination.')
  .meta({ id: 'LogMessage' })
export type LogMessage = z.infer<typeof LogMessage>

export const ErrorMessage = z
  .object({
    type: z.literal('error'),
    failure_type: z
      .enum(['config_error', 'system_error', 'transient_error', 'auth_error'])
      .describe('Error category — lets the orchestrator decide whether to retry, alert, or abort.'),
    message: z.string().describe('Human-readable error description.'),
    stream: z.string().optional().describe('Stream that triggered the error, if applicable.'),
    stack_trace: z.string().optional().describe('Full stack trace for debugging.'),
  })
  .describe('Structured error from a source or destination.')
  .meta({ id: 'ErrorMessage' })
export type ErrorMessage = z.infer<typeof ErrorMessage>

export const StreamStatusMessage = z
  .object({
    type: z.literal('stream_status'),
    stream: z.string().describe('Stream being reported on.'),
    status: z
      .enum(['started', 'running', 'complete', 'incomplete'])
      .describe('Current phase of the stream within this sync run.'),
  })
  .describe(
    'Per-stream status update from a source. Enables progress reporting in CLI / dashboard.'
  )
  .meta({ id: 'StreamStatusMessage' })
export type StreamStatusMessage = z.infer<typeof StreamStatusMessage>

/**
 * Terminal message — always the last line in an NDJSON streaming response.
 * Tells the client why the stream ended so it can decide whether to call again.
 */
export const EofMessage = z
  .object({
    type: z.literal('eof'),
    reason: z.enum(['complete', 'state_limit', 'time_limit', 'error']),
  })
  .meta({ id: 'EofMessage' })
export type EofMessage = z.infer<typeof EofMessage>

// MARK: - Pipeline params

/** Parameters for a sync pipeline — source/destination config and optional stream selection. */
export const PipelineConfig = z.object({
  source: z.object({ type: z.string() }).catchall(z.unknown()),
  destination: z.object({ type: z.string() }).catchall(z.unknown()),
  streams: z
    .array(
      z.object({
        name: z.string(),
        sync_mode: z.enum(['incremental', 'full_refresh']).optional(),
        fields: z.array(z.string()).optional(),
        backfill_limit: z.number().int().positive().optional(),
      })
    )
    .optional(),
})
export type PipelineConfig = z.infer<typeof PipelineConfig>

/** @deprecated Use PipelineConfig */
export const SyncEngineParams = PipelineConfig
/** @deprecated Use PipelineConfig */
export type SyncEngineParams = PipelineConfig

/** The full set of parsed sync request params: pipeline config + cursor state + stream limits. */
export interface SyncParams {
  pipeline: PipelineConfig
  state?: Record<string, unknown>
  stateLimit?: number
  timeLimitMs?: number
}

// MARK: - Message unions

/** The subset of messages the destination receives. */
export const DestinationInput = z.discriminatedUnion('type', [RecordMessage, StateMessage])
export type DestinationInput = z.infer<typeof DestinationInput>

/** Messages the destination yields back to the orchestrator (one per NDJSON line). */
export const DestinationOutput = z
  .discriminatedUnion('type', [StateMessage, ErrorMessage, LogMessage, EofMessage])
  .meta({ id: 'DestinationOutput' })
export type DestinationOutput = z.infer<typeof DestinationOutput>

/** Any message flowing through the engine. One message per NDJSON line. */
export const Message = z
  .discriminatedUnion('type', [
    RecordMessage,
    StateMessage,
    CatalogMessage,
    LogMessage,
    ErrorMessage,
    StreamStatusMessage,
    EofMessage,
  ])
  .meta({ id: 'Message' })
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
  setup?(params: { config: TConfig; catalog: ConfiguredCatalog }): Promise<Partial<TConfig> | void>

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
    $stdin: AsyncIterable<DestinationInput>
  ): AsyncIterable<DestinationOutput>

  /** Provision downstream resources (schemas, tables, etc.). Called before first write(). */
  setup?(params: { config: TConfig; catalog: ConfiguredCatalog }): Promise<Partial<TConfig> | void>

  /** Clean up downstream resources. Called when a sync is deleted. */
  teardown?(params: { config: TConfig }): Promise<void>
}
