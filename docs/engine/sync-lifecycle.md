# Sync Lifecycle

How finite sync runs work: run identity, opaque state, optional time ranges, and
terminal stream status. For message types and connector interfaces, see
[protocol.md](./protocol.md).

## Scope

This design is intentionally narrow:

- Incremental backfills only.
- Finite reads only.
- `full_refresh` is out of scope.
- Live `/events` polling is out of scope.
- Generic stall detection is out of scope.

## Removed From This Protocol

To keep lifecycle semantics tight, this protocol explicitly removes these ideas:

- **No `full_refresh` lifecycle.** `sync_mode: 'full_refresh'` and
  `destination_sync_mode: 'overwrite'` are not part of this protocol. They need
  separate semantics because "done for this run" and "historical coverage" mean
  different things for a full reread.
- **No `range_complete`-driven terminality.** `range_complete` remains optional
  progress telemetry only. It does not drive `has_more`.
- **No cross-request range subdivision in the protocol.** The protocol does not
  assume that a partially paginated time range can be split into smaller ranges
  between requests.

## Motivation

The base protocol treats each `read()` call as independent. The caller manages
pagination, upper bounds, and continuation externally. That creates three
problems:

1. **Backfill bounds shift between calls.** A stream that derives its own upper
   bound from `now()` can chase a moving target forever.
2. **No run identity.** Multiple requests that belong to one logical backfill
   have no shared context.
3. **Completion is ambiguous.** If the engine inspects source-specific state to
   guess whether a stream is done, protocol behavior depends on connector
   internals instead of explicit source signals.

This design introduces **sync runs** as a first-class concept. The engine owns
run identity and optional outer time bounds. The source owns pagination and
emits explicit lifecycle signals.

---

## Layers

```
CLIENT  ←—start/end—→  ENGINE  ←—iterator—→  SOURCE
```

| Concern             | Client                                | Engine                                                    | Source                                                 |
| ------------------- | ------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| What to sync        | Provides catalog                      | Passes catalog through, may inject `time_range`           | Syncs what it's given                                  |
| When to sync        | Decides                               | —                                                         | —                                                      |
| Run identity        | Generates `sync_run_id`               | Tracks run continuity                                     | Unaware                                                |
| Time range bounds   | —                                     | Freezes `started_at`, injects `time_range` when supported | Respects `time_range` if present                       |
| Internal pagination | —                                     | —                                                         | Manages `starting_after` / equivalent                  |
| Stream lifecycle    | Consumes                              | Tracks terminal streams                                   | Emits `started`, optional `range_complete`, `complete` |
| Progress reporting  | Consumes                              | Emits run-level snapshots                                 | Emits records, checkpoints, traces                     |
| Error reporting     | Decides retry policy above the engine | Passes through, stops on `global`                         | Classifies and emits trace errors                      |
| State               | Opaque round-trip                     | Manages engine section                                    | Manages source section                                 |
| `has_more`          | Reads, acts                           | Derives from explicit terminal stream state               | —                                                      |

---

## Core Rule

The engine trusts only explicit stream status messages for lifecycle:

- `started` means the stream is active for this request.
- `range_complete` is progress telemetry only.
- `complete` is the only terminal signal.

The engine does **not** inspect source state to infer completion. Source state is
opaque cursor data.

---

## Messages

### `start` — client → engine

Begins or continues a sync run. See [Types](#types) for `StartPayload`.

### `end` — engine → client

The request is done. See [Types](#types) for `EndPayload`.

`has_more: true` means at least one configured stream has not emitted
`stream_status: complete` for this run yet. Continue by sending another `start`
with the same `sync_run_id` and the previous `ending_state` as the next
`starting_state`.

`has_more: false` means every configured stream is terminal for this run. The
next sync should use a new `sync_run_id`.

### Source → engine

Sources are iterators that yield these message types:

```ts
// Data record
{ type: 'record', record: { stream: string, data: Record<string, unknown>, emitted_at: string } }

// Checkpoint. Data is opaque to the engine.
{ type: 'source_state', source_state: { state_type: 'stream', stream: string, data: unknown } }

// Global checkpoint for source-wide state.
{ type: 'source_state', source_state: { state_type: 'global', data: unknown } }

// Stream status
{ type: 'trace', trace: { trace_type: 'stream_status', stream_status: StreamStatus } }

// Error
{ type: 'trace', trace: { trace_type: 'error', error: SyncError & { stack_trace?: string } } }

// Diagnostic log
{ type: 'log', log: { level: 'debug' | 'info' | 'warn' | 'error', message: string } }
```

### Engine → client

The engine emits four message types: `progress`, `record`, `log`, and `end`.

```ts
{
  type: 'progress',
  progress: {
    elapsed_ms: number,
    global_state_count: number,
    derived: {
      records_per_second: number,
      states_per_second: number,
    },
    streams: Record<string, StreamProgress>,
    errors: SyncError[]
  }
}

{ type: 'record', record: { stream: string, data: Record<string, unknown>, emitted_at: string } }

{ type: 'log', log: { level: 'info' | 'warn' | 'error', message: string } }

{
  type: 'end',
  end: {
    has_more: boolean,
    ending_state: SyncState,
    request_progress: ProgressPayload,
  }
}
```

The engine does not pass trace messages through to the client. It folds them
into `progress` and `log`.

---

## Stream Status

`stream_status` is a discriminated union on `status`:

```ts
type StreamStatus =
  | { stream: string; status: 'started' }
  | { stream: string; status: 'range_complete'; range_complete: { gte: string; lt: string } }
  | { stream: string; status: 'complete' }
```

| Status           | Meaning                         | Engine action                   |
| ---------------- | ------------------------------- | ------------------------------- |
| `started`        | Stream is active                | Mark stream active for progress |
| `range_complete` | A time range finished           | Update progress only            |
| `complete`       | Stream is terminal for this run | Mark stream terminal            |

`range_complete` is optional and only meaningful for streams that support
engine-assigned `time_range`. It is not used to derive `has_more`.

A source that decides to stop a stream after a stream-level error should still
emit `complete` for that stream. That keeps lifecycle semantics explicit:
errors explain _why_ the stream stopped; `complete` says it is terminal.

---

## Types

### Configured catalog (client → engine → source)

The client provides the catalog. The engine may inject `time_range` into
streams that support it.

```ts
type ConfiguredStream = {
  name: string
  primary_key: string[][]
  json_schema?: Record<string, unknown>
  sync_mode: 'incremental'
  destination_sync_mode: 'append' | 'append_dedup'
  cursor_field?: string[]
  backfill_limit?: number

  // Source capability from discover/spec.
  supports_time_range?: boolean

  // Set by engine only when supports_time_range is true.
  time_range?: {
    gte?: string
    lt: string
  }
}

type ConfiguredCatalog = {
  streams: ConfiguredStream[]
}
```

### Start message (client → engine)

```ts
type StartPayload = {
  sync_run_id: string
  source_config: Record<string, unknown>
  destination_config: Record<string, unknown>
  configured_catalog: ConfiguredCatalog
  starting_state?: SyncState
}
```

### End message (engine → client)

```ts
type EndPayload = {
  has_more: boolean
  ending_state: SyncState
  request_progress: ProgressPayload
}
```

### Progress message (engine → client)

```ts
type SyncError =
  | { error_level: 'global'; message: string }
  | { error_level: 'stream'; message: string; stream: string }
  | { error_level: 'transient'; message: string; stream?: string }

type StreamProgress = {
  state_count: number
  record_count: number
  completed_ranges?: Array<{ gte: string; lt: string }>
  terminal: boolean
}

type ProgressPayload = {
  elapsed_ms: number
  global_state_count: number
  derived: {
    records_per_second: number
    states_per_second: number
  }
  streams: Record<string, StreamProgress>
  errors: SyncError[]
}
```

`completed_ranges` is progress data only. It does not determine completion.

### SyncState (round-tripped between start and end)

```ts
type SyncState = {
  source: SourceState
  engine: EngineState
}

type SourceState = {
  streams: Record<string, unknown>
  global: Record<string, unknown>
}

type EngineState = {
  sync_run_id: string
  started_at: string
  terminal_streams: string[]
  run_progress: ProgressPayload
}
```

### Source state — Stripe example

Source state is opaque to the engine. For Stripe list endpoints, the source can
store the last emitted object ID as `starting_after`:

```ts
type StripeStreamState = {
  starting_after: string | null
}
```

For time-range streams, the assigned `time_range` lives in the catalog, not in
source state.

---

## Sync Runs

A sync run is identified by `sync_run_id`. Within a run, `started_at` is frozen.

### New run

1. Client sends `start` with a new `sync_run_id`.
2. Engine freezes `started_at = now()` and stores it in engine state.
3. For each configured stream where `supports_time_range` is true, the engine
   injects `time_range.lt = started_at`.
4. Source runs, emits records, checkpoints, and explicit stream statuses.
5. Engine emits progress, forwards records to the destination, and returns
   `end`.

### Continuation

1. Client sends `start` with the same `sync_run_id` and previous `ending_state`.
2. Engine preserves `started_at` from engine state.
3. The engine re-injects the same `time_range` into streams that support it.
4. Source resumes from its opaque cursor state.

### Completion

When `has_more: false`:

- Every configured stream is present in `engine.terminal_streams`.
- The client should start the next sync with a new `sync_run_id`.

### Example

```
sync_run_id: "sr_1"
  request 1: customers [2018, 2024) → timed out → end { has_more: true }
  request 2: customers [2018, 2024) → complete  → end { has_more: false }
```

The range is stable across requests. The source resumes within that range using
its own cursor state.

---

## Time Ranges

Time range support is optional per stream.

### Streams with `supports_time_range: true`

- The engine injects `time_range`.
- `time_range.lt` is frozen to `started_at` for the duration of the run.
- The source resumes within that range using opaque source state.
- The source may emit `range_complete` for progress reporting.

### Streams with `supports_time_range: false`

- The engine does not inject `time_range`.
- The source paginates using its own cursor semantics only.
- No coverage accounting is implied.

### Why this matters

- Frozen upper bounds prevent moving-target backfills for eligible streams.
- Streams without time filtering still fit the same continuation contract.
- The engine never needs to understand source-specific pagination tokens.

---

## `has_more` Derivation

The engine derives `has_more` from explicit terminal stream state:

```ts
has_more = configured_catalog.streams.some(
  (stream) => !engine.terminal_streams.includes(stream.name)
)
```

`completed_ranges` and source-state shape do not participate in this decision.

---

## Error Handling

### Error levels

| `error_level` | Blast radius        | Engine action                        | Example               |
| ------------- | ------------------- | ------------------------------------ | --------------------- |
| `global`      | Entire sync         | Abort all streams, `has_more: false` | Invalid API key       |
| `stream`      | One stream          | Keep processing other streams        | Resource unavailable  |
| `transient`   | One request or page | Informational                        | Rate limited, retried |

### Source → engine error flow

```ts
{ type: 'trace', trace: { trace_type: 'error', error: SyncError } }
```

### Engine behavior

- `global`: stop immediately and emit `end { has_more: false }`
- `stream`: record the error and continue with other streams
- `transient`: record the error only

Errors are not stored in source state. They are separate from lifecycle.

---

## Engine Logs

The engine emits `log` messages for anomalies and failures only.

### warn

| Message                          | When                                                          |
| -------------------------------- | ------------------------------------------------------------- |
| `state before started: {stream}` | Source emitted `source_state` before `stream_status: started` |
| `state after complete: {stream}` | Source emitted `source_state` after `stream_status: complete` |
| `duplicate started: {stream}`    | Source emitted `stream_status: started` twice                 |
| `unknown stream: {stream}`       | Source emitted a message for a stream not in the catalog      |

### error

| Message                             | When                                 |
| ----------------------------------- | ------------------------------------ |
| `global error: {message}`           | Source emitted `error_level: global` |
| `stream error: {stream}: {message}` | Source emitted `error_level: stream` |
| `source crashed: {message}`         | Source iterator threw                |

---

## Wire Format

NDJSON. One message per line.

```json
{"type":"start","sync_run_id":"sr_abc","source_config":{},"configured_catalog":{"streams":[{"name":"customers","sync_mode":"incremental","supports_time_range":true}]}}
{"type":"progress","progress":{"elapsed_ms":100,"global_state_count":0,"derived":{"records_per_second":0,"states_per_second":0},"streams":{"customers":{"state_count":0,"record_count":0,"completed_ranges":[],"terminal":false}},"errors":[]}}
{"type":"record","record":{"stream":"customers","data":{"id":"cus_123"}}}
{"type":"progress","progress":{"elapsed_ms":1600,"global_state_count":1,"derived":{"records_per_second":1562,"states_per_second":0.6},"streams":{"customers":{"state_count":1,"record_count":2500,"completed_ranges":[],"terminal":false}},"errors":[]}}
{"type":"progress","progress":{"elapsed_ms":3200,"global_state_count":2,"derived":{"records_per_second":1562,"states_per_second":0.6},"streams":{"customers":{"state_count":2,"record_count":5000,"completed_ranges":[{"gte":"2018-01-01T00:00:00Z","lt":"2024-04-17T00:00:00Z"}],"terminal":true}},"errors":[]}}
{"type":"end","end":{"has_more":false,"ending_state":{"source":{"streams":{"customers":{"starting_after":null}},"global":{}},"engine":{"sync_run_id":"sr_abc","started_at":"2024-04-17T00:00:00Z","terminal_streams":["customers"],"run_progress":{"elapsed_ms":3200,"global_state_count":2,"derived":{"records_per_second":1562,"states_per_second":0.6},"streams":{"customers":{"state_count":2,"record_count":5000,"completed_ranges":[{"gte":"2018-01-01T00:00:00Z","lt":"2024-04-17T00:00:00Z"}],"terminal":true}},"errors":[]}}},"request_progress":{"elapsed_ms":3200,"global_state_count":2,"derived":{"records_per_second":1562,"states_per_second":0.6},"streams":{"customers":{"state_count":2,"record_count":5000,"completed_ranges":[{"gte":"2018-01-01T00:00:00Z","lt":"2024-04-17T00:00:00Z"}],"terminal":true}},"errors":[]}}}
```

---

## Client Loop

```ts
let state = undefined
const syncRunId = crypto.randomUUID()

do {
  const { end } = await engine.sync({
    sync_run_id: syncRunId,
    source_config,
    destination_config,
    configured_catalog,
    starting_state: state,
  })
  state = end.ending_state
} while (end.has_more)
```

The client does not need to interpret source state. It only needs to round-trip
`ending_state` and continue until `has_more` is false.
