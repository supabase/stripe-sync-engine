// Sync Engine — Protocol
//
// Zod schemas and inferred types for the sync protocol. Data shapes (messages,
// catalog, config) are runtime-validatable via Zod. Source and Destination
// contracts remain as TS interfaces (generic, method-bearing).
//
// Wire format: Airbyte-aligned envelope messages. Every message is a JSON object
// with a `type` discriminator and a single payload field matching the type name.
// All commands return AsyncIterable<Message> — everything is a stream.

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

// MARK: - Payload schemas (inner objects — no `type` field)

/** JSON Schema describing the configuration a connector requires. Also the payload of a spec message. */
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

export const RecordPayload = z
  .object({
    stream: z.string().describe('Stream (table) name this record belongs to.'),
    data: z.record(z.string(), z.unknown()).describe('The record payload as a key-value map.'),
    emitted_at: z
      .string()
      .datetime()
      .describe('ISO 8601 timestamp when the record was emitted by the source.'),
  })
  .describe('One record for one stream.')
export type RecordPayload = z.infer<typeof RecordPayload>

export const StatePayload = z
  .object({
    stream: z.string().describe('Stream being checkpointed.'),
    data: z
      .unknown()
      .describe(
        'Opaque checkpoint data — only the source understands its contents. The orchestrator persists it keyed by stream and passes it back on resume.'
      ),
  })
  .describe('Per-stream checkpoint for resumable syncs.')
export type StatePayload = z.infer<typeof StatePayload>

export const CatalogPayload = z
  .object({
    streams: z.array(Stream).describe('All streams available from this source.'),
  })
  .describe('Catalog of available streams.')
export type CatalogPayload = z.infer<typeof CatalogPayload>

export const LogPayload = z
  .object({
    level: z.enum(['debug', 'info', 'warn', 'error']).describe('Log severity level.'),
    message: z.string().describe('Human-readable log message.'),
  })
  .describe('Structured log output from a connector.')
export type LogPayload = z.infer<typeof LogPayload>

export const EofPayload = z
  .object({
    reason: z
      .enum(['complete', 'state_limit', 'time_limit', 'error'])
      .describe('Why the stream ended.'),
  })
  .describe('Terminal payload — tells the client why the stream ended.')
export type EofPayload = z.infer<typeof EofPayload>

export const ConnectionStatusPayload = z
  .object({
    status: z.enum(['succeeded', 'failed']).describe('Whether the connection check passed.'),
    message: z.string().optional().describe('Human-readable explanation of the check result.'),
  })
  .describe('Result of a connection check.')
export type ConnectionStatusPayload = z.infer<typeof ConnectionStatusPayload>

export const ControlPayload = z
  .object({
    control_type: z
      .enum(['config_update'])
      .describe('What kind of control action the connector is requesting.'),
    config: z
      .record(z.string(), z.unknown())
      .describe('Config fields to merge into the active connector configuration.'),
  })
  .describe('Control signal from a connector to the orchestrator.')
export type ControlPayload = z.infer<typeof ControlPayload>

// Trace subtypes

export const TraceError = z
  .object({
    failure_type: z
      .enum(['config_error', 'system_error', 'transient_error', 'auth_error'])
      .describe('Error category — lets the orchestrator decide whether to retry, alert, or abort.'),
    message: z.string().describe('Human-readable error description.'),
    stream: z.string().optional().describe('Stream that triggered the error, if applicable.'),
    stack_trace: z.string().optional().describe('Full stack trace for debugging.'),
  })
  .describe('Structured error from a connector.')
export type TraceError = z.infer<typeof TraceError>

export const TraceStreamStatus = z
  .object({
    stream: z.string().describe('Stream being reported on.'),
    status: z
      .enum(['started', 'running', 'complete', 'incomplete'])
      .describe('Current phase of the stream within this sync run.'),
  })
  .describe('Per-stream status update.')
export type TraceStreamStatus = z.infer<typeof TraceStreamStatus>

export const TraceEstimate = z
  .object({
    stream: z.string().describe('Stream being estimated.'),
    row_count: z.number().int().optional().describe('Estimated total row count for this stream.'),
    byte_count: z.number().int().optional().describe('Estimated total byte count for this stream.'),
  })
  .describe('Sync progress estimate for a stream.')
export type TraceEstimate = z.infer<typeof TraceEstimate>

export const TracePayload = z
  .discriminatedUnion('trace_type', [
    z.object({
      trace_type: z.literal('error'),
      error: TraceError,
    }),
    z.object({
      trace_type: z.literal('stream_status'),
      stream_status: TraceStreamStatus,
    }),
    z.object({
      trace_type: z.literal('estimate'),
      estimate: TraceEstimate,
    }),
  ])
  .describe('Diagnostic/status payload with subtypes for error, stream status, and estimates.')
export type TracePayload = z.infer<typeof TracePayload>

// MARK: - Envelope messages (the wire format)
//
// Every message is { type: '<kind>', <kind>: <payload> }.
// One message per NDJSON line.

export const RecordMessage = z
  .object({ type: z.literal('record'), record: RecordPayload })
  .meta({ id: 'RecordMessage' })
export type RecordMessage = z.infer<typeof RecordMessage>

export const StateMessage = z
  .object({ type: z.literal('state'), state: StatePayload })
  .meta({ id: 'StateMessage' })
export type StateMessage = z.infer<typeof StateMessage>

export const CatalogMessage = z
  .object({ type: z.literal('catalog'), catalog: CatalogPayload })
  .meta({ id: 'CatalogMessage' })
export type CatalogMessage = z.infer<typeof CatalogMessage>

export const LogMessage = z
  .object({ type: z.literal('log'), log: LogPayload })
  .meta({ id: 'LogMessage' })
export type LogMessage = z.infer<typeof LogMessage>

export const TraceMessage = z
  .object({ type: z.literal('trace'), trace: TracePayload })
  .meta({ id: 'TraceMessage' })
export type TraceMessage = z.infer<typeof TraceMessage>

export const SpecMessage = z
  .object({ type: z.literal('spec'), spec: ConnectorSpecification })
  .meta({ id: 'SpecMessage' })
export type SpecMessage = z.infer<typeof SpecMessage>

export const ConnectionStatusMessage = z
  .object({
    type: z.literal('connection_status'),
    connection_status: ConnectionStatusPayload,
  })
  .meta({ id: 'ConnectionStatusMessage' })
export type ConnectionStatusMessage = z.infer<typeof ConnectionStatusMessage>

export const ControlMessage = z
  .object({ type: z.literal('control'), control: ControlPayload })
  .meta({ id: 'ControlMessage' })
export type ControlMessage = z.infer<typeof ControlMessage>

export const EofMessage = z
  .object({ type: z.literal('eof'), eof: EofPayload })
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

/** The full set of parsed sync request params: pipeline config + cursor state + stream limits. */
export interface SyncParams {
  pipeline: PipelineConfig
  state?: Record<string, unknown>
  stateLimit?: number
  timeLimit?: number
}

// MARK: - Message unions

/** The subset of messages the destination receives on stdin. */
export const DestinationInput = z.discriminatedUnion('type', [RecordMessage, StateMessage])
export type DestinationInput = z.infer<typeof DestinationInput>

/** Messages the destination yields back to the orchestrator (one per NDJSON line). */
export const DestinationOutput = z
  .discriminatedUnion('type', [StateMessage, TraceMessage, LogMessage, EofMessage])
  .meta({ id: 'DestinationOutput' })
export type DestinationOutput = z.infer<typeof DestinationOutput>

/** Any message flowing through the engine. One message per NDJSON line. */
export const Message = z
  .discriminatedUnion('type', [
    RecordMessage,
    StateMessage,
    CatalogMessage,
    LogMessage,
    TraceMessage,
    SpecMessage,
    ConnectionStatusMessage,
    ControlMessage,
    EofMessage,
  ])
  .meta({ id: 'Message' })
export type Message = z.infer<typeof Message>

// MARK: - Per-command output types

/** Output of spec(): the connector's specification, plus optional logs/traces. */
export type SpecOutput = SpecMessage | LogMessage | TraceMessage

/** Output of check(): connection status, plus optional logs/traces. */
export type CheckOutput = ConnectionStatusMessage | LogMessage | TraceMessage

/** Output of discover(): catalog of streams, plus optional logs/traces. */
export type DiscoverOutput = CatalogMessage | LogMessage | TraceMessage

/** Output of setup(): config update controls, plus optional logs/traces. */
export type SetupOutput = ControlMessage | LogMessage | TraceMessage

/** Output of teardown(): optional logs/traces. */
export type TeardownOutput = LogMessage | TraceMessage

// MARK: - Source
//
// In-process sources implement this interface directly.
// Subprocess sources read/write NDJSON on stdin/stdout and a thin
// adapter converts between the two.
//
// Every method returns AsyncIterable<Message> — everything is a stream.

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
 */
export interface Source<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TStreamState = unknown,
  TInput = unknown,
> {
  /** Emit the connector's specification (config JSON Schema, etc.). */
  spec(): AsyncIterable<SpecOutput>

  /** Check connectivity and config validity. */
  check(params: { config: TConfig }): AsyncIterable<CheckOutput>

  /** Discover available streams. */
  discover(params: { config: TConfig }): AsyncIterable<DiscoverOutput>

  /** Emit messages (record, state, log, trace). Finite for backfill, infinite for live. */
  read(
    params: {
      config: TConfig
      catalog: ConfiguredCatalog
      state?: Record<string, TStreamState>
    },
    $stdin?: AsyncIterable<TInput>
  ): AsyncIterable<Message>

  /** Provision external resources (webhook endpoints, replication slots, etc.). */
  setup?(params: { config: TConfig; catalog: ConfiguredCatalog }): AsyncIterable<SetupOutput>

  /** Clean up external resources. Called when a sync is deleted. */
  teardown?(params: { config: TConfig }): AsyncIterable<TeardownOutput>
}

// MARK: - Destination
//
// In-process destinations implement this interface directly.
// Subprocess destinations read DestinationInputs from stdin and emit
// DestinationOutput on stdout after committing.
//
// Every method returns AsyncIterable<Message> — everything is a stream.

/**
 * Writes records into a downstream system.
 *
 * A destination can be a database, spreadsheet, warehouse, Stripe API
 * (e.g. Custom Objects for reverse ETL), Kafka topic, etc.
 *
 * TConfig is the connector's configuration type, inferred from its Zod spec.
 *
 * The destination only receives RecordMessage and StateMessage on stdin — the
 * orchestrator filters out other message types before they reach the destination.
 */
export interface Destination<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  /** Emit the connector's specification (config JSON Schema, etc.). */
  spec(): AsyncIterable<SpecOutput>

  /** Check connectivity and config validity. */
  check(params: { config: TConfig }): AsyncIterable<CheckOutput>

  /**
   * Consume data messages and write records to the downstream system.
   * Yields messages back to the orchestrator: state after committing,
   * trace on write failures, log for diagnostics.
   */
  write(
    params: { config: TConfig; catalog: ConfiguredCatalog },
    $stdin: AsyncIterable<DestinationInput>
  ): AsyncIterable<DestinationOutput>

  /** Provision downstream resources (schemas, tables, etc.). */
  setup?(params: { config: TConfig; catalog: ConfiguredCatalog }): AsyncIterable<SetupOutput>

  /** Clean up downstream resources. Called when a sync is deleted. */
  teardown?(params: { config: TConfig }): AsyncIterable<TeardownOutput>
}

// MARK: - Deprecated aliases (for migration)

/** @deprecated Use ConnectionStatusPayload */
export const CheckResult = ConnectionStatusPayload
/** @deprecated Use ConnectionStatusPayload */
export type CheckResult = ConnectionStatusPayload
