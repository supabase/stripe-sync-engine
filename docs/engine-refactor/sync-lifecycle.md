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

| Concern             | Client                                | Engine                                                      | Source                                                       |
| ------------------- | ------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| What to sync        | Provides catalog                      | Passes catalog through, may inject `time_range`             | Syncs what it's given                                        |
| When to sync        | Decides                               | —                                                           | —                                                            |
| Run identity        | Generates `sync_run_id`               | Tracks run continuity                                       | Unaware                                                      |
| Time range bounds   | —                                     | Freezes `time_ceiling`, injects `time_range` when supported | Respects `time_range` if present                             |
| Internal pagination | —                                     | —                                                           | Manages `starting_after` / equivalent                        |
| Stream lifecycle    | Consumes                              | Tracks progress                                             | Emits `start`, optional `range_complete`, `complete`, `skip` |
| Progress reporting  | Consumes                              | Emits run-level snapshots                                   | Emits records, checkpoints, stream_status                    |
| Error reporting     | Decides retry policy above the engine | Passes through logs                                         | Logs errors, exhausts if unrecoverable                       |
| State               | Opaque round-trip                     | Manages engine section                                      | Manages source section                                       |
| `has_more`          | Reads, acts                           | Derives from stream progress                                | —                                                            |

---

## Core Rule

The engine trusts only explicit stream status messages for lifecycle:

- `start` means the stream is active for this request.
- `range_complete` is progress telemetry only.
- `complete` is the only terminal signal.

The engine does **not** inspect source state to infer completion. Source state is
opaque cursor data.

---

## Messages

### Source → engine

Sources are iterators that yield five message types:

```ts
// Data record
{ type: 'record', record: { stream: string, data: Record<string, unknown>, emitted_at: string } }

// Checkpoint. Data is opaque to the engine.
{ type: 'source_state', source_state: { state_type: 'stream', stream: string, data: unknown } }

// Global checkpoint for source-wide state.
{ type: 'source_state', source_state: { state_type: 'global', data: unknown } }

// Stream lifecycle event
{ type: 'stream_status', stream_status: StreamStatus }

// Global error (unrecoverable — source exhausts after emitting this)
{ type: 'connection_status', connection_status: { status: 'failed', message: string } }

// Log (diagnostics)
{ type: 'log', log: { level: 'debug' | 'info' | 'warn' | 'error', message: string, stream?: string } }
```

Global errors use `connection_status: failed` (same message type as `check()`).
The source emits it then exhausts. Stream errors use `stream_status: error`.
Logs are informational only — the engine passes them through but does not act
on them.

### Engine → client

The engine streams these message types to the client (via destination re-emit):

```ts
// Progress snapshot
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
  }
}

// State checkpoint (confirmed by destination)
{ type: 'source_state', source_state: { state_type: 'stream', stream: string, data: unknown } }

// Stream lifecycle event (confirmed by destination)
{ type: 'stream_status', stream_status: StreamStatus }

// Log
{ type: 'log', log: { level: 'info' | 'warn' | 'error', message: string, stream?: string } }

// EOF — always the last message on the response stream
{
  type: 'eof',
  eof: {
    has_more: boolean,           // true = source cut off; false = source exhausted
    ending_state: SyncState,    // round-trip this as starting_state on next request
    run_progress: ProgressPayload,     // accumulated across entire run
    request_progress: ProgressPayload, // this request only
  }
}
```

The engine emits the first `progress` immediately after discover + catalog
construction, before the source has sent any data. This gives the client
immediate visibility into the configured streams and their initial statuses
(all `not_started`, or reflecting prior run state on continuation).

`eof` is always the last message. It carries:

- `has_more` — whether the client should call again
- `ending_state` — full state to round-trip on the next request
- `run_progress` — cumulative progress across all requests in this run
- `request_progress` — what happened in this specific request only

---

## Stream Status

`stream_status` is a discriminated union on `status`:

```ts
type StreamStatus =
  | { stream: string; status: 'start' }
  | { stream: string; status: 'range_complete'; range_complete: { gte: string; lt: string } }
  | { stream: string; status: 'complete' }
  | { stream: string; status: 'error'; error: string }
  | { stream: string; status: 'skip'; reason: string }
```

| Status           | Meaning                      | Engine action                   |
| ---------------- | ---------------------------- | ------------------------------- |
| `start`          | Stream is active             | Mark stream active for progress |
| `range_complete` | A time range finished        | Update progress only            |
| `complete`       | Stream is done for this run  | Mark stream done                |
| `error`          | Stream failed                | Mark stream done, record error  |
| `skip`           | Stream will not be processed | No work, record reason          |

`range_complete` is optional and only meaningful for streams that support
engine-assigned `time_range`. It is not used to derive `has_more`.

Terminal statuses are `complete`, `error`, and `skip`. A stream ends with
exactly one of these. `error` means the stream tried and failed. `skip` means
it was never attempted. `complete` means it finished successfully.

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
type StreamProgress = {
  status: 'not_started' | 'started' | 'completed' | 'skipped' | 'errored' // current state, derived from stream_status events
  state_count: number
  record_count: number
  completed_ranges?: Array<{ gte: string; lt: string }>
}

type ProgressPayload = {
  started_at: string // when this sync started; generally equals time_ceiling
  elapsed_ms: number
  global_state_count: number
  connection_status?: { status: 'failed'; message: string } // set when source emits connection_status: failed
  derived: {
    status: 'started' | 'succeeded' | 'failed' // succeeded = all streams completed/skipped; failed = connection_status failed OR any stream errored
    records_per_second: number
    states_per_second: number
  }
  streams: Record<string, StreamProgress>
}
```

`completed_ranges` is progress data only. It does not determine completion.

#### Deriving `StreamProgress.status` from events

```ts
stream_status event  →  StreamProgress.status
─────────────────────────────────────────────
(no event yet)       →  'not_started'
'start'              →  'started'
'complete'           →  'completed'
'error'              →  'errored'
'skip'               →  'skipped'
'range_complete'     →  no status change (appends to completed_ranges)
```

### SyncState

```ts
type SyncState = {
  source: SourceState
  destination: DestinationState
  sync_run: SyncRunState
}

type SourceState = {
  streams: Record<string, unknown>
  global: Record<string, unknown>
}

type DestinationState = Record<string, unknown>

type SyncRunState = {
  sync_run_id?: string // omit for continuous sync
  time_ceiling?: string // frozen upper bound; set only when sync_run_id is present
  progress: ProgressPayload // accumulated across all requests in this run
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

- The engine freezes `time_ceiling = now()` on the first invocation and persists
  it in `SyncRunState`.
- On continuation (same `sync_run_id` in state), `time_ceiling` is reused →
  `time_range.lt` stays frozen.
- On continuation, the engine removes streams with terminal statuses
  (`completed`, `errored`, `skipped`) from the configured catalog passed to
  the source. Only streams still in `started` or `not_started` are included.
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

|                   | With `sync_run_id`                        | Without `sync_run_id`         |
| ----------------- | ----------------------------------------- | ----------------------------- |
| Upper bound       | Frozen at first `time_ceiling`            | None                          |
| Terminates?       | Yes — source exhausts within frozen bound | Not guaranteed                |
| Progress tracking | Accumulated in `SyncRunState`             | Accumulated in `SyncRunState` |
| Use case          | Finite backfill                           | Testing only                  |

---

## Time Ranges

Time range support is optional per stream.

### Streams with `supports_time_range: true`

- The engine injects `time_range`.
- `time_range.lt` is frozen to `time_ceiling` when `sync_run_id` is set.
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

Stream status, `completed_ranges`, `progress`, and source-state shape do
not participate in this decision.

---

## Error Handling

| Scenario                            | What the source does                                           |
| ----------------------------------- | -------------------------------------------------------------- |
| Global error (invalid API key)      | Emits `connection_status: failed` with reason, then exhausts   |
| Stream error (resource unavailable) | Emits `stream_status: error` for that stream, continues others |
| Transient (rate limited, retried)   | Logs warn, retries internally                                  |

### Global errors

The source emits `connection_status` (already used by `check()`) during
`read()` when it hits an unrecoverable error:

```ts
{ type: 'connection_status', connection_status: { status: 'failed', message: 'invalid API key' } }
```

The engine collects this into `progress.connection_status`. The source then
exhausts — the engine sees iterator done and emits eof.

### Stream errors

Per-stream failures use `stream_status: error`. Other streams continue.

### Logs

Error logs (`level: 'error'`) are informational only. The engine passes them
through but does not act on them. Errors are not stored in source state.

---

## Engine Logs

The engine emits `log` messages for anomalies and failures only.

### debug

| Message                          | When                                                          |
| -------------------------------- | ------------------------------------------------------------- |
| `state before start: {stream}`   | Source emitted `source_state` before `stream_status: start`   |
| `state after complete: {stream}` | Source emitted `source_state` after `stream_status: complete` |
| `duplicate start: {stream}`      | Source emitted `stream_status: start` twice                   |
| `unknown stream: {stream}`       | Source emitted a message for a stream not in the catalog      |

### error

| Message                     | When                  |
| --------------------------- | --------------------- |
| `source crashed: {message}` | Source iterator threw |

---
