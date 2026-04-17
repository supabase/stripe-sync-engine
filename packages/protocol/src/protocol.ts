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

// MARK: - Aggregate state

export const SectionState = z
  .object({
    streams: z
      .record(z.string(), z.unknown())
      .describe('Per-stream checkpoint data, keyed by stream name.'),
    global: z
      .record(z.string(), z.unknown())
      .describe('Section-wide state shared across all streams.'),
  })
  .describe('A partition of sync state with per-stream and global slots.')
export type SectionState = z.infer<typeof SectionState>

export const SyncState = z
  .object({
    source: SectionState.describe(
      'Source connector state — cursors, backfill progress, events cursors.'
    ),
    destination: SectionState.describe('Destination connector state — reserved for future use.'),
    engine: SectionState.describe(
      'Engine-managed state — cumulative record counts, sync metadata not owned by connectors.'
    ),
  })
  .describe(
    'Full sync checkpoint with separate sections for source, destination, and engine. ' +
      'Connectors only see their own section; the engine manages routing.'
  )
  .meta({ id: 'SyncState' })
export type SyncState = z.infer<typeof SyncState>

/** @deprecated Use SectionState. */
export const SourceState = SectionState.meta({ id: 'SourceState' })
/** @deprecated Use SectionState. */
export type SourceState = SectionState

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

    time_range: z
      .object({
        gte: z.string().describe('Inclusive lower bound (ISO 8601).'),
        lt: z.string().describe('Exclusive upper bound (ISO 8601).'),
      })
      .optional()
      .describe(
        'Time window for this stream. The engine computes this from synced_ranges + started_at. ' +
          'Sources use it as the created filter range. If absent, the source computes its own range.'
      ),
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
    source_state_stream: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'JSON Schema for per-stream state (cursor/checkpoint shape). See also SourceState.global for sync-wide cursors.'
      ),
    source_input: z
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

export const StreamStatePayload = z
  .object({
    state_type: z.literal('stream').default('stream'),
    stream: z.string().describe('Stream being checkpointed.'),
    data: z
      .unknown()
      .describe(
        'Opaque checkpoint data — only the source understands its contents. The orchestrator persists it keyed by stream and passes it back on resume.'
      ),
  })
  .describe('Per-stream checkpoint for resumable syncs.')
export type StreamStatePayload = z.infer<typeof StreamStatePayload>

export const GlobalStatePayload = z
  .object({
    state_type: z.literal('global'),
    data: z
      .unknown()
      .describe('Sync-wide state shared across all streams (e.g. a global events cursor).'),
  })
  .describe('Sync-wide checkpoint shared across all streams.')
export type GlobalStatePayload = z.infer<typeof GlobalStatePayload>

/**
 * Wire-format state payload — discriminated on `state_type`.
 *
 * Uses `z.union` (not `z.discriminatedUnion`) so that old messages without
 * `state_type` fall through to `StreamStatePayload` where `.default('stream')`
 * fills it in. New messages with `state_type: 'global'` fail the stream literal
 * and match `GlobalStatePayload`.
 */
export const StatePayload = z.union([StreamStatePayload, GlobalStatePayload])
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

export const ConnectionStatusPayload = z
  .object({
    status: z.enum(['succeeded', 'failed']).describe('Whether the connection check passed.'),
    message: z.string().optional().describe('Human-readable explanation of the check result.'),
  })
  .describe('Result of a connection check.')
export type ConnectionStatusPayload = z.infer<typeof ConnectionStatusPayload>

export const ControlPayload = z
  .discriminatedUnion('control_type', [
    z.object({
      control_type: z.literal('source_config'),
      source_config: z
        .record(z.string(), z.unknown())
        .describe(
          'Full updated source configuration. The connector must emit the complete config, not a partial diff. The orchestrator replaces the stored config wholesale.'
        ),
    }),
    z.object({
      control_type: z.literal('destination_config'),
      destination_config: z
        .record(z.string(), z.unknown())
        .describe(
          'Full updated destination configuration. The connector must emit the complete config, not a partial diff. The orchestrator replaces the stored config wholesale.'
        ),
    }),
  ])
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
      .enum([
        'start',
        'running',
        'complete',
        'range_complete',
        'transient_error',
        'system_error',
        'config_error',
        'auth_error',
      ])
      .describe('Current phase of the stream within this sync run.'),
    range_complete: z
      .object({
        gte: z.string().describe('Inclusive lower bound (ISO 8601).'),
        lt: z.string().describe('Exclusive upper bound (ISO 8601).'),
      })
      .optional()
      .describe('Present when status is range_complete. The sub-range that finished.'),
    cumulative_record_count: z
      .number()
      .int()
      .optional()
      .describe(
        'Cumulative records synced for this stream across all sync runs. ' +
          'Monotonically increasing; initialized from engine state on resume. ' +
          'Set by the engine, not the source.'
      ),
    run_record_count: z
      .number()
      .int()
      .optional()
      .describe('Records synced for this stream in the current sync run. Set by the engine.'),
    window_record_count: z
      .number()
      .int()
      .optional()
      .describe(
        'Records synced since the last stream_status emission for this stream. ' +
          'Set by the engine. Used for instantaneous per-stream throughput.'
      ),
    records_per_second: z
      .number()
      .optional()
      .describe(
        'Average records per second for this stream over the entire run: ' +
          'run_record_count / elapsed seconds. Set by the engine.'
      ),
    requests_per_second: z
      .number()
      .optional()
      .describe(
        'Average API requests per second for this stream over the entire run. ' +
          'Set by the engine from source-reported request counts.'
      ),
  })
  .describe(
    'Per-stream status update. Sources emit the minimal form (stream + status). ' +
      'The engine emits enriched versions with record counts and throughput rates.'
  )
export type TraceStreamStatus = z.infer<typeof TraceStreamStatus>

export const TraceEstimate = z
  .object({
    stream: z.string().describe('Stream being estimated.'),
    row_count: z.number().int().optional().describe('Estimated total row count for this stream.'),
    byte_count: z.number().int().optional().describe('Estimated total byte count for this stream.'),
  })
  .describe('Sync progress estimate for a stream.')
export type TraceEstimate = z.infer<typeof TraceEstimate>

export const TraceProgress = z
  .object({
    elapsed_ms: z.number().int().describe('Wall-clock milliseconds since the sync run started.'),
    run_record_count: z
      .number()
      .int()
      .describe('Total records synced across all streams in this run.'),
    rows_per_second: z
      .number()
      .describe('Overall throughput for the entire run: run_record_count / elapsed seconds.'),
    window_rows_per_second: z
      .number()
      .describe(
        'Instantaneous throughput: total records in last window / window duration. ' +
          'Measures only the most recent reporting interval.'
      ),
    state_checkpoint_count: z
      .number()
      .int()
      .describe('Total source_state messages observed so far in this sync run.'),
  })
  .describe(
    'Periodic global sync progress emitted by the engine. ' +
      'Aggregate stats only — per-stream detail is in stream_status messages. ' +
      'Each emission is a full replacement.'
  )
export type TraceProgress = z.infer<typeof TraceProgress>

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
    z.object({
      trace_type: z.literal('progress'),
      progress: TraceProgress,
    }),
  ])
  .describe(
    'Diagnostic/status payload with subtypes for error, stream status, estimates, and progress.'
  )
export type TracePayload = z.infer<typeof TracePayload>

// MARK: - EOF payload (depends on TraceProgress)

export const EofStreamProgress = z
  .object({
    status: z
      .enum([
        'start',
        'running',
        'complete',
        'range_complete',
        'transient_error',
        'system_error',
        'config_error',
        'auth_error',
      ])
      .describe('Final stream status.'),
    cumulative_record_count: z
      .number()
      .int()
      .describe('Cumulative records synced for this stream across all runs.'),
    run_record_count: z.number().int().describe('Records synced in this run.'),
    records_per_second: z
      .number()
      .optional()
      .describe('Average records/sec for this stream over the run.'),
    requests_per_second: z
      .number()
      .optional()
      .describe('Average requests/sec for this stream over the run.'),
    errors: z
      .array(
        z.object({
          message: z.string().describe('Human-readable error description.'),
          failure_type: z
            .enum(['config_error', 'system_error', 'transient_error', 'auth_error'])
            .optional()
            .describe('Error category matching TraceError.failure_type.'),
        })
      )
      .optional()
      .describe('All accumulated errors for this stream during this run.'),
  })
  .describe('End-of-sync summary for a single stream.')
export type EofStreamProgress = z.infer<typeof EofStreamProgress>

export const EofPayload = z
  .object({
    reason: z
      .enum(['complete', 'state_limit', 'time_limit', 'error', 'aborted'])
      .describe('Why the sync run ended.'),
    cutoff: z
      .enum(['soft', 'hard'])
      .optional()
      .describe(
        'Present when reason is time_limit. soft = stopped gracefully between messages; hard = forcibly interrupted a blocked operation.'
      ),
    elapsed_ms: z
      .number()
      .optional()
      .describe(
        'Wall-clock milliseconds elapsed since the stream started. Always present when reason is time_limit or aborted.'
      ),
    state: SyncState.optional().describe(
      'Full sync state at the end of the run. source: accumulated from source_state messages; ' +
        'engine: updated cumulative record counts; destination: reserved. ' +
        'Consumers can persist this directly and pass it back on resume.'
    ),
    global_progress: TraceProgress.optional().describe(
      'Final global aggregates. Same shape as trace/progress.'
    ),
    stream_progress: z
      .record(z.string(), EofStreamProgress)
      .optional()
      .describe(
        'Per-stream end-of-sync summary. Errors only appear here, not in stream_status messages.'
      ),
  })
  .describe(
    'Terminal message with two nested sections: ' +
      'global_progress (same shape as trace/progress) and ' +
      'stream_progress (final per-stream detail including accumulated errors).'
  )
export type EofPayload = z.infer<typeof EofPayload>

// MARK: - Envelope messages (the wire format)
//
// Every message is { type: '<kind>', <kind>: <payload> }.
// One message per NDJSON line.
//
// MessageBase carries engine-injected metadata (underscore-prefixed fields).
// Connectors never set these — the engine populates them when assembling pipelines.

export const MessageBase = z.object({
  _emitted_by: z
    .string()
    .optional()
    .describe(
      'Who emitted this message: "source/{type}", "destination/{type}", or "engine". Set by the engine.'
    ),
  _ts: z
    .string()
    .datetime()
    .optional()
    .describe('ISO 8601 timestamp when the engine observed this message.'),
})
export type MessageBase = z.infer<typeof MessageBase>

export const RecordMessage = MessageBase.extend({
  type: z.literal('record'),
  record: RecordPayload,
}).meta({ id: 'RecordMessage' })
export type RecordMessage = z.infer<typeof RecordMessage>

export const SourceStateMessage = MessageBase.extend({
  type: z.literal('source_state'),
  source_state: StatePayload,
}).meta({ id: 'SourceStateMessage' })
export type SourceStateMessage = z.infer<typeof SourceStateMessage>

export const CatalogMessage = MessageBase.extend({
  type: z.literal('catalog'),
  catalog: CatalogPayload,
}).meta({ id: 'CatalogMessage' })
export type CatalogMessage = z.infer<typeof CatalogMessage>

export const LogMessage = MessageBase.extend({
  type: z.literal('log'),
  log: LogPayload,
}).meta({ id: 'LogMessage' })
export type LogMessage = z.infer<typeof LogMessage>

export const TraceMessage = MessageBase.extend({
  type: z.literal('trace'),
  trace: TracePayload,
}).meta({ id: 'TraceMessage' })
export type TraceMessage = z.infer<typeof TraceMessage>

export const SpecMessage = MessageBase.extend({
  type: z.literal('spec'),
  spec: ConnectorSpecification,
}).meta({ id: 'SpecMessage' })
export type SpecMessage = z.infer<typeof SpecMessage>

export const ConnectionStatusMessage = MessageBase.extend({
  type: z.literal('connection_status'),
  connection_status: ConnectionStatusPayload,
}).meta({ id: 'ConnectionStatusMessage' })
export type ConnectionStatusMessage = z.infer<typeof ConnectionStatusMessage>

export const ControlMessage = MessageBase.extend({
  type: z.literal('control'),
  control: ControlPayload,
}).meta({ id: 'ControlMessage' })
export type ControlMessage = z.infer<typeof ControlMessage>

export const EofMessage = MessageBase.extend({
  type: z.literal('eof'),
  eof: EofPayload,
}).meta({ id: 'EofMessage' })
export type EofMessage = z.infer<typeof EofMessage>

// MARK: - Pipeline params

/**
 * Parameters for a sync pipeline — source/destination config and optional stream selection.
 *
 * Source and destination use a nested envelope format:
 *   `{ type: 'stripe', stripe: { api_key: '...' } }`
 *
 * The loose `catchall` schema accepts any extra keys (including the nested payload key)
 * without validating the inner shape — validation happens in the engine via the connector spec.
 */
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

// MARK: - Message unions

/** The subset of messages the destination receives on stdin. */
export const DestinationInput = z.discriminatedUnion('type', [RecordMessage, SourceStateMessage])
export type DestinationInput = z.infer<typeof DestinationInput>

/** Messages the destination yields back to the orchestrator (one per NDJSON line). */
export const DestinationOutput = z
  .discriminatedUnion('type', [SourceStateMessage, TraceMessage, LogMessage, EofMessage])
  .meta({ id: 'DestinationOutput' })
export type DestinationOutput = z.infer<typeof DestinationOutput>

/** Output of pipeline_sync(): destination output plus source signals (controls, logs, traces). */
export const SyncOutput = z
  .discriminatedUnion('type', [
    SourceStateMessage,
    TraceMessage,
    LogMessage,
    EofMessage,
    ControlMessage,
  ])
  .meta({ id: 'SyncOutput' })
export type SyncOutput = z.infer<typeof SyncOutput>

/** Any message flowing through the engine. One message per NDJSON line. */
export const Message = z
  .discriminatedUnion('type', [
    RecordMessage,
    SourceStateMessage,
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

/**
 * Wire envelope for a single source input item (e.g. a webhook event payload).
 * `source_input` carries the connector-specific payload; connectors narrow its type via
 * `Source<TConfig, TStreamState, TInput>`.
 */
export const SourceInputMessage = MessageBase.extend({
  type: z.literal('source_input'),
  source_input: z.unknown(),
}).meta({ id: 'SourceInputMessage' })
export type SourceInputMessage = z.infer<typeof SourceInputMessage>

// MARK: - Per-command output types

/** Output of spec(): the connector's specification, plus optional logs/traces. */
export const SpecOutput = z
  .discriminatedUnion('type', [SpecMessage, LogMessage, TraceMessage])
  .meta({ id: 'SpecOutput' })
export type SpecOutput = z.infer<typeof SpecOutput>

/** Output of check(): connection status, plus optional logs/traces. */
export const CheckOutput = z
  .discriminatedUnion('type', [ConnectionStatusMessage, LogMessage, TraceMessage])
  .meta({ id: 'CheckOutput' })
export type CheckOutput = z.infer<typeof CheckOutput>

/** Output of discover(): catalog of streams, plus optional logs/traces. */
export const DiscoverOutput = z
  .discriminatedUnion('type', [CatalogMessage, LogMessage, TraceMessage])
  .meta({ id: 'DiscoverOutput' })
export type DiscoverOutput = z.infer<typeof DiscoverOutput>

/** Output of setup(): config update controls, plus optional logs/traces. */
export const SetupOutput = z
  .discriminatedUnion('type', [ControlMessage, LogMessage, TraceMessage])
  .meta({ id: 'SetupOutput' })
export type SetupOutput = z.infer<typeof SetupOutput>

/** Output of teardown(): optional logs/traces. */
export const TeardownOutput = z
  .discriminatedUnion('type', [LogMessage, TraceMessage])
  .meta({ id: 'TeardownOutput' })
export type TeardownOutput = z.infer<typeof TeardownOutput>

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
 *   TSourceStreamState — per-stream checkpoint shape (opaque to the orchestrator)
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

  /**
   * Emit messages (record, state, log, trace). Finite for backfill, infinite for live.
   *
   * Cancellation is cooperative and iterator-driven: consumers stop work by
   * calling `return()` (for example via early exit from `for await`).
   */
  read(
    params: {
      config: TConfig
      catalog: ConfiguredCatalog
      state?: SourceState
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
 * The destination only receives RecordMessage and SourceStateMessage on stdin — the
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
