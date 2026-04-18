# Sync Lifecycle

How finite sync runs work: run identity, opaque state, and optional time ranges.
For message types and connector interfaces, see [protocol.md](../engine/protocol.md).

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
| Stream lifecycle    | Consumes                              | Tracks progress                                           | Emits `started`, optional `range_complete`, `complete` |
| Progress reporting  | Consumes                              | Emits run-level snapshots                                 | Emits records, checkpoints, traces                     |
| Error reporting     | Decides retry policy above the engine | Passes through, stops on `global`                         | Classifies and emits trace errors                      |
| State               | Opaque round-trip                     | Manages engine section                                    | Manages source section                                 |
| `has_more`          | Reads, acts                           | Derives from stream progress                              | —                                                      |

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

The engine emits three message types: `progress`, `record`, and `log`.

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
```

For the future `start`/`end` request–response protocol, see
[sync-lifecycle-start-end-message.md](./sync-lifecycle-start-end-message.md).

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

### SyncState

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
  sync_run_id?: string // omit for continuous sync
  started_at?: string // set only when sync_run_id is present
  run_progress: ProgressPayload
}
```

For the full start/end round-trip semantics, see
[sync-lifecycle-start-end-message.md](./sync-lifecycle-start-end-message.md).

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

`sync_run_id` is optional. When provided, it freezes the upper bound so the
backfill has a finite target. When omitted, the upper bound is `now()` on every
invocation — the sync never "finishes" and continuously chases new data.

### With `sync_run_id` (finite backfill)

- The engine freezes `started_at = now()` on the first invocation and persists
  it in `EngineState`.
- On continuation (same `sync_run_id` in state), `started_at` is reused →
  `time_range.lt` stays frozen.
- The run is complete when the source iterator exhausts (returns naturally).
- Progress accumulates across invocations.

### Without `sync_run_id` (continuous sync)

- The engine does not inject `time_range.lt`. There is no upper bound.
- The source paginates forward indefinitely. It may terminate if it catches
  up to the present, but this is not guaranteed — new data can arrive faster
  than the source reads it.
- There is no progress tracking across invocations — each call is independent.
- Useful for continuous polling where "done" is not a meaningful concept.

### Summary

|                   | With `sync_run_id`                        | Without `sync_run_id`     |
| ----------------- | ----------------------------------------- | ------------------------- |
| Upper bound       | Frozen at first `started_at`              | None                      |
| Terminates?       | Yes — source exhausts within frozen bound | Not guaranteed            |
| Progress tracking | Accumulated in `EngineState`              | Accumulated in `EngineState` |
| Use case          | Finite backfill                           | Testing only                 |

---

## Time Ranges

Time range support is optional per stream.

### Streams with `supports_time_range: true`

- The engine injects `time_range`.
- `time_range.lt` is frozen to `started_at` when `sync_run_id` is set.
  Without `sync_run_id`, no `time_range.lt` is injected.
- The source resumes within that range using opaque source state.
- The source may emit `range_complete` for progress reporting.

### Streams with `supports_time_range: false`

- The engine does not inject `time_range`.
- The source paginates using its own cursor semantics only.
- No coverage accounting is implied.

### Why this matters

- With `sync_run_id`: frozen upper bounds prevent moving-target backfills.
- Without `sync_run_id`: no upper bound enables continuous sync.
- Streams without time filtering still fit the same continuation contract.
- The engine never needs to understand source-specific pagination tokens.

---

## `has_more` Derivation

`has_more` is determined solely by whether the source iterator is exhausted:

```ts
has_more = !iterator.done
```

If the source yields all its messages and returns, `has_more: false`. If the
source is cut off (time limit, backfill limit, signal), `has_more: true`.

Stream status, `completed_ranges`, `run_progress`, and source-state shape do
not participate in this decision.

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
