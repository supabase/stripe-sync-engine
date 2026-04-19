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

export const SourceState = z
  .object({
    streams: z
      .record(z.string(), z.unknown())
      .describe('Per-stream checkpoint data, keyed by stream name.'),
    global: z
      .record(z.string(), z.unknown())
      .describe('Source-wide state shared across all streams.'),
  })
  .describe('Source connector state — cursors, backfill progress, events cursors.')
  .meta({ id: 'SourceState' })
export type SourceState = z.infer<typeof SourceState>

/** @deprecated Use SourceState. */
export const SectionState = SourceState
/** @deprecated Use SourceState. */
export type SectionState = SourceState

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

    newer_than_field: z
      .string()
      .optional()
      .describe(
        'Field whose value increases monotonically. Destination uses it to skip stale writes (e.g. "created").'
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

    supports_time_range: z
      .boolean()
      .optional()
      .describe(
        'Source capability from discover/spec. When true, the engine may inject time_range.'
      ),

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

/** Per-request aggregate stats. Used in EOF and periodic progress snapshots. */

// MARK: - Stream status payload (top-level message type)

export const StreamStatusPayload = z
  .discriminatedUnion('status', [
    z.object({
      stream: z.string().describe('Stream being reported on.'),
      status: z.literal('start'),
    }),
    z.object({
      stream: z.string().describe('Stream being reported on.'),
      status: z.literal('range_complete'),
      range_complete: z
        .object({
          gte: z.string().describe('Inclusive lower bound (ISO 8601).'),
          lt: z.string().describe('Exclusive upper bound (ISO 8601).'),
        })
        .describe('The sub-range that finished.'),
    }),
    z.object({
      stream: z.string().describe('Stream being reported on.'),
      status: z.literal('complete'),
    }),
    z.object({
      stream: z.string().describe('Stream being reported on.'),
      status: z.literal('error'),
      error: z.string().describe('Human-readable error description.'),
    }),
    z.object({
      stream: z.string().describe('Stream being reported on.'),
      status: z.literal('skip'),
      reason: z.string().describe('Why the stream was skipped.'),
    }),
  ])
  .describe(
    'Stream lifecycle event. Sources emit these; the engine tracks stream progress from them.'
  )
export type StreamStatusPayload = z.infer<typeof StreamStatusPayload>

// MARK: - Progress payload (top-level message type)

export const StreamProgress = z
  .object({
    status: z
      .enum(['not_started', 'started', 'completed', 'skipped', 'errored'])
      .describe('Current state, derived from stream_status events.'),
    state_count: z.number().int().describe('Number of state checkpoints for this stream.'),
    record_count: z.number().int().describe('Records synced for this stream in this run.'),
    completed_ranges: z
      .array(
        z.object({
          gte: z.string().describe('Inclusive lower bound (ISO 8601).'),
          lt: z.string().describe('Exclusive upper bound (ISO 8601).'),
        })
      )
      .optional()
      .describe('Completed time sub-ranges for streams that support time_range.'),
  })
  .describe('Per-stream progress snapshot.')
export type StreamProgress = z.infer<typeof StreamProgress>

export const ProgressPayload = z
  .object({
    started_at: z
      .string()
      .describe('When this sync started (ISO 8601); generally equals time_ceiling.'),
    elapsed_ms: z.number().int().describe('Wall-clock milliseconds since the sync run started.'),
    global_state_count: z.number().int().describe('Total source_state messages observed so far.'),
    connection_status: ConnectionStatusPayload.optional().describe(
      'Set when source or destination emits connection_status: failed.'
    ),
    derived: z
      .object({
        status: z
          .enum(['started', 'succeeded', 'failed'])
          .describe(
            'succeeded = all streams completed/skipped; failed = connection_status failed OR any stream errored.'
          ),
        records_per_second: z.number().describe('Overall throughput for the entire run.'),
        states_per_second: z.number().describe('State checkpoints per second.'),
      })
      .describe('Computed aggregates.'),
    streams: z
      .record(z.string(), StreamProgress)
      .describe('Per-stream progress, keyed by stream name.'),
  })
  .describe(
    'Periodic sync progress emitted by the engine as a top-level message. Each emission is a full replacement.'
  )
export type ProgressPayload = z.infer<typeof ProgressPayload>

// MARK: - Sync run state

export const SyncRunState = z
  .object({
    sync_run_id: z
      .string()
      .optional()
      .describe('Identifies a finite backfill run. Omit for continuous sync.'),
    time_ceiling: z
      .string()
      .optional()
      .describe(
        'Frozen upper bound (ISO 8601). Set on first invocation when sync_run_id is present; reused on continuation.'
      ),
    progress: ProgressPayload.describe(
      'Accumulated progress from prior requests in this run.'
    ),
  })
  .describe('Engine-managed run state — run identity, frozen bounds, accumulated progress.')
export type SyncRunState = z.infer<typeof SyncRunState>

export const SyncState = z
  .object({
    source: SourceState.describe(
      'Source connector state — cursors, backfill progress, events cursors.'
    ),
    destination: z.record(z.string(), z.unknown()).describe('Destination connector state.'),
    sync_run: SyncRunState.describe(
      'Engine-managed run state — sync_run_id, time_ceiling, accumulated progress.'
    ),
  })
  .describe(
    'Full sync checkpoint with separate sections for source, destination, and sync run. ' +
      'Connectors only see their own section; the engine manages routing.'
  )
  .meta({ id: 'SyncState' })
export type SyncState = z.infer<typeof SyncState>

// MARK: - EOF payload

export const EofStreamProgress = z
  .object({
    status: z
      .enum(['not_started', 'started', 'completed', 'errored', 'skipped'])
      .describe('Final stream status, derived from stream_status events.'),
    cumulative_record_count: z
      .number()
      .int()
      .describe('Cumulative records synced for this stream across all runs.'),
    run_record_count: z.number().int().describe('Records synced in this request.'),
    records_per_second: z
      .number()
      .optional()
      .describe('Average records/sec for this stream over the request.'),
    errors: z
      .array(z.object({ message: z.string().describe('Human-readable error description.') }))
      .optional()
      .describe('All accumulated errors for this stream during this request.'),
  })
  .describe('Per-stream end-of-request summary.')
export type EofStreamProgress = z.infer<typeof EofStreamProgress>

export const EofPayload = z
  .object({
    has_more: z
      .boolean()
      .describe(
        'Whether the client should continue with another request. ' +
          'true when cut off by limits; false when the source iterator exhausted naturally.'
      ),
    ending_state: SyncState.optional().describe(
      'Full sync state at the end of this request. ' +
        'Round-trip this as starting_state on the next request.'
    ),
    run_progress: ProgressPayload.describe(
      'Accumulated progress across all requests in this sync run.'
    ),
    request_progress: ProgressPayload.describe('Progress for this specific request only.'),
  })
  .describe('Terminal message signaling end of this request.')
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

export const StreamStatusMessage = MessageBase.extend({
  type: z.literal('stream_status'),
  stream_status: StreamStatusPayload,
}).meta({ id: 'StreamStatusMessage' })
export type StreamStatusMessage = z.infer<typeof StreamStatusMessage>

export const ProgressMessage = MessageBase.extend({
  type: z.literal('progress'),
  progress: ProgressPayload,
}).meta({ id: 'ProgressMessage' })
export type ProgressMessage = z.infer<typeof ProgressMessage>

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

/** Core connector messages — the fundamental types that sources and destinations emit. */
/**
 * Extended message types (engine-level, not emitted by connectors directly).
 */
export const SourceInputMessage = MessageBase.extend({
  type: z.literal('source_input'),
  source_input: z.unknown(),
}).meta({ id: 'SourceInputMessage' })
export type SourceInputMessage = z.infer<typeof SourceInputMessage>

/**
 * The single message union. All other message types are derived from this via Extract.
 * One Zod schema = one TypeScript type = no structural mismatches.
 */
export const Message = z
  .discriminatedUnion('type', [
    RecordMessage,
    SourceStateMessage,
    CatalogMessage,
    LogMessage,
    SpecMessage,
    ConnectionStatusMessage,
    StreamStatusMessage,
    ControlMessage,
    ProgressMessage,
    EofMessage,
    SourceInputMessage,
  ])
  .meta({ id: 'Message' })
export type Message = z.infer<typeof Message>

// MARK: - Derived message subsets
//
// All derived from the single Message union. Types use Extract for structural
// compatibility. Runtime schemas share the same underlying Zod member schemas
// so parsed values are assignable to Message without casts.

/** Core connector messages — record, state, lifecycle, logs. */
export const CoreMessage = z
  .discriminatedUnion('type', [
    RecordMessage,
    SourceStateMessage,
    CatalogMessage,
    LogMessage,
    SpecMessage,
    ConnectionStatusMessage,
    StreamStatusMessage,
    ControlMessage,
  ])
  .meta({ id: 'CoreMessage' })
export type CoreMessage = z.infer<typeof CoreMessage>

/** Extended messages — engine-level (progress, eof, source input). */
export type ExtendedMessage = Extract<
  Message,
  { type: 'progress' } | { type: 'eof' } | { type: 'source_input' }
>

/**
 * Messages the destination receives on stdin. Destinations must handle `record`
 * and `source_state`; all other message types must be yielded back as pass-through.
 */
export const DestinationInput = Message
export type DestinationInput = Message

/**
 * Messages the destination yields back to the orchestrator. Includes both
 * destination-originated messages (logs, connection_status) and pass-through
 * messages from the source that the destination doesn't handle.
 */
export const DestinationOutput = Message
export type DestinationOutput = Message

/** Output of pipeline_sync streamed to the client. */
export const SyncOutput = z
  .discriminatedUnion('type', [
    SourceStateMessage,
    StreamStatusMessage,
    ProgressMessage,
    ConnectionStatusMessage,
    LogMessage,
    EofMessage,
    ControlMessage,
  ])
  .meta({ id: 'SyncOutput' })
export type SyncOutput = z.infer<typeof SyncOutput>

// MARK: - Per-command output types

/** Output of spec(): the connector's specification, plus optional logs. */
export const SpecOutput = z
  .discriminatedUnion('type', [SpecMessage, LogMessage])
  .meta({ id: 'SpecOutput' })
export type SpecOutput = z.infer<typeof SpecOutput>

/** Output of check(): connection status, plus optional logs. */
export const CheckOutput = z
  .discriminatedUnion('type', [ConnectionStatusMessage, LogMessage])
  .meta({ id: 'CheckOutput' })
export type CheckOutput = z.infer<typeof CheckOutput>

/** Output of discover(): catalog of streams, plus optional logs. */
export const DiscoverOutput = z
  .discriminatedUnion('type', [CatalogMessage, LogMessage])
  .meta({ id: 'DiscoverOutput' })
export type DiscoverOutput = z.infer<typeof DiscoverOutput>

/** Output of setup(): config update controls, plus optional logs. */
export const SetupOutput = z
  .discriminatedUnion('type', [ControlMessage, LogMessage])
  .meta({ id: 'SetupOutput' })
export type SetupOutput = z.infer<typeof SetupOutput>

/** Output of teardown(): optional logs. */
export const TeardownOutput = z
  .discriminatedUnion('type', [LogMessage])
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
 *   TSourceState       — per-stream checkpoint shape (opaque to the engine)
 *   TInput       — serializable data passed to read() for event-driven reads
 *                  (e.g. a single webhook event). When absent, read() performs
 *                  a pull-based backfill.
 */
export interface Source<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
  TSourceState = unknown,
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
      state?: { streams: Record<string, TSourceState>; global: Record<string, unknown> }
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
