# Sync Engine Architecture

## Design Principles

1. **Source and destination agnostic.** The engine does not assume Stripe is the source. Data can flow in any direction — Stripe → Postgres, Postgres → Stripe Custom Objects, any source → Google Sheets, etc.

2. **Everything is a message.** All communication uses a single `Message` type, serialized as NDJSON (one JSON object per line). This applies whether sources and destinations run in-process or as subprocesses.

3. **Subprocess-ready.** The protocol is designed so that any source or destination can be extracted into a standalone process that reads/writes NDJSON on stdin/stdout. A thin adapter bridges subprocess sources and destinations to the in-process TypeScript interfaces.

4. **Resumable by default.** Sources emit `StateMessage` checkpoints between records. The orchestrator persists these and passes them back on restart, so syncs resume where they left off rather than starting over.

5. **Schema is discovered, not hardcoded.** Sources advertise available streams and their JSON Schemas via `CatalogMessage`. The destination uses this to create tables, validate records, and plan migrations.

## Message Protocol

Every unit flowing through the engine is a `Message`, discriminated by `type`:

| Type            | Direction                            | Purpose                                                      |
| --------------- | ------------------------------------ | ------------------------------------------------------------ |
| `record`        | source → destination                 | One data record for one stream                               |
| `state`         | source → destination → orchestrator  | Checkpoint for resumable syncs                               |
| `catalog`       | source → orchestrator                | Stream discovery (names, schemas, keys)                      |
| `log`           | source or destination → orchestrator | Structured log output                                        |
| `error`         | source or destination → orchestrator | Structured error with failure type                           |
| `stream_status` | source → orchestrator                | Per-stream progress (started, running, complete, incomplete) |

Messages are serialized as NDJSON — one JSON line per message. This format works for both in-process async iterators and subprocess stdin/stdout pipes.

## Source

A source reads data from an upstream system by emitting messages. It can be finite (backfill) or infinite (live/streaming). The same interface covers REST API polling, webhook ingestion, event bridge, Kafka replay, database CDC, etc.

### In-process

```typescript
interface Source {
  discover(): Promise<CatalogMessage>
  read(streams: Stream[], state?: StateMessage): AsyncIterableIterator<Message>
}
```

### Subprocess

```
source discover --config config.json           → emits CatalogMessage
source read     --config config.json \
                --catalog catalog.json \
                --state state.json             → emits Message lines on stdout
```

## Destination

A destination writes messages into a downstream system. It can be a database, spreadsheet, warehouse, Stripe API (e.g. Custom Objects for reverse ETL), Kafka topic, etc.

The destination receives a catalog (to set up streams/tables/schemas) and a stream of messages. It yields `StateMessage` back to confirm committed checkpoints.

### In-process

```typescript
interface Destination {
  write(
    catalog: CatalogMessage,
    messages: AsyncIterableIterator<Message>
  ): AsyncIterableIterator<StateMessage>
}
```

### Subprocess

```
destination write --config config.json \
                  --catalog catalog.json       ← reads Message lines from stdin
                                               → emits StateMessage on stdout after committing
```

### What the destination receives

The destination only sees `RecordMessage` and `StateMessage`. The orchestrator filters out everything else before it reaches the destination.

| Message               | Reaches destination?                              |
| --------------------- | ------------------------------------------------- |
| `RecordMessage`       | Yes — write it                                    |
| `StateMessage`        | Yes — re-emit after committing preceding records  |
| `ErrorMessage`        | No — orchestrator handles (retry, abort, alert)   |
| `LogMessage`          | No — orchestrator routes to observability         |
| `StreamStatusMessage` | No — orchestrator updates progress UI             |
| `CatalogMessage`      | No — used during discover, before the pipe starts |

## Data Model

### Stream

A **stream** is a named collection of records — a table, API resource, or object type. Streams carry:

- `name` — collection name (e.g. `customers`, `pg_public.users`)
- `primary_key` — composite key paths for deduplication (e.g. `[["id"]]`)
- `json_schema` — record shape, discovered at runtime
- `metadata` — source-specific fields that apply to every record in the stream (e.g. `api_version`, `account_id`, `live_mode` for Stripe sources)

### RecordMessage

A single data record. The primary key is not a top-level field — it is extracted from `data` using the stream's `primary_key` paths.

```json
{
  "type": "record",
  "stream": "customers",
  "data": { "id": "cus_123", "name": "Acme" },
  "emitted_at": 1710700000000
}
```

### StateMessage

A per-stream checkpoint used as a **commit fence**. Each `StateMessage` carries a `stream` field so the orchestrator knows which stream is being checkpointed, and an opaque `data` field only the source understands.

Properties:

1. **Per-stream.** Each `StateMessage` checkpoints one stream. The orchestrator maintains a state map keyed by `(sync_id, stream)` and merges checkpoints as they arrive.

2. **Opaque to the destination.** The destination must not read, modify, or interpret the `data` field. Only the source understands its contents.

3. **Commit fence.** The source interleaves `StateMessage` between `RecordMessage`s. When the destination has durably committed all records **preceding** a `StateMessage`, it re-emits that same `StateMessage` unchanged. This is the confirmation that those records are safe.

4. **Resumability is source-controlled.** The source decides checkpoint granularity. A source that emits state after every record gives fine-grained resume. A source that emits state once at the end gives all-or-nothing. If the source never emits a `StateMessage`, the sync works but is not resumable — a restart means starting over.

```json
{"type":"state","stream":"customers","data":{"after":"cus_999"}}
{"type":"state","stream":"invoices","data":{"after":"inv_500"}}
```

### ErrorMessage

A structured error from a source or destination. The `failure_type` field lets the orchestrator decide how to respond:

- `config_error` — bad credentials, missing permissions. Don't retry, alert the user.
- `system_error` — bug in the source or destination. Don't retry, alert the developer.
- `transient_error` — network timeout, rate limit, temporary outage. Retry with backoff.

```json
{
  "type": "error",
  "failure_type": "transient_error",
  "message": "rate limited",
  "stream": "customers"
}
```

### StreamStatusMessage

Per-stream progress updates from a source. Enables progress reporting in the CLI and dashboard.

```json
{ "type": "stream_status", "stream": "customers", "status": "running" }
```

## Orchestrator

The orchestrator reads from both the source and the destination:

```
Source → Orchestrator → Destination
              ↑               │
              └───────────────┘
```

**From the source**, the orchestrator receives all message types:

| Source message        | Orchestrator action                   |
| --------------------- | ------------------------------------- |
| `RecordMessage`       | Forward to destination                |
| `StateMessage`        | Forward to destination                |
| `ErrorMessage`        | Handle directly (retry, abort, alert) |
| `LogMessage`          | Route to observability                |
| `StreamStatusMessage` | Update progress UI                    |

**From the destination**, the orchestrator receives:

| Destination message | Orchestrator action                        |
| ------------------- | ------------------------------------------ |
| `StateMessage`      | Persist committed checkpoint for resume    |
| `ErrorMessage`      | Handle write failure (retry, abort, alert) |
| `LogMessage`        | Route to observability                     |

### Minimal sync

```typescript
const catalog = await source.discover()
const messages = source.read(catalog.streams)

// orchestrator filters: only RecordMessage and StateMessage reach the destination
const data = filter_data_messages(messages)
const output = destination.write(catalog, data)

for await (const msg of output) {
  if (msg.type === 'state') persist(msg)
  if (msg.type === 'error') handle_error(msg)
}
```

### State flow

The `StateMessage` flows through the entire pipeline before being persisted. It is the destination's re-emission that confirms records are committed — not just read from the source.

```
Source                    Orchestrator                    Destination
  │                            │                              │
  ├─ RecordMessage ───────────►├─ RecordMessage ─────────────►│
  ├─ RecordMessage ───────────►├─ RecordMessage ─────────────►│
  ├─ State{customers,cur:50} ─►├─ State{customers,cur:50} ──►│
  ├─ LogMessage ──────────────►├── (route to logs)            │
  │                            │                              ├── (upsert + commit)
  │                            │◄─ State{customers,cur:50} ──┤
  │                            ├── (persist checkpoint)       │
  ├─ RecordMessage ───────────►├─ RecordMessage ─────────────►│
  ├─ ErrorMessage ────────────►├── (handle error)             │
  ├─ State{invoices,cur:99} ──►├─ State{invoices,cur:99} ───►│
  │                            │                              ├── (upsert + commit)
  │                            │◄─ State{invoices,cur:99} ───┤
  │                            ├── (persist checkpoint)       │
  │                            │                              │
```

On the next run, the orchestrator passes the last persisted `StateMessage` back to `source.read(streams, state)`, and the source resumes from that checkpoint.

### Flushing vs checkpointing

These are two different things:

- **Flush** — write buffered records to the downstream system (e.g. INSERT into Postgres). The destination does this on its own schedule based on internal heuristics (batch size, time, memory pressure). It does not need a `StateMessage` to flush.

- **Checkpoint** — re-emit a `StateMessage` to confirm a resume point. The destination can only do this after it has flushed all records preceding that `StateMessage`.

A `StateMessage` does not mean "flush now." It means "once you have flushed everything up to here, tell the orchestrator it is safe to resume from this point."

If the source never emits a `StateMessage`, the destination still flushes normally — it just never confirms a checkpoint. If the sync crashes, it restarts from the beginning because the orchestrator has no saved state.

### Source controls checkpoint granularity

The source controls how often the destination can checkpoint — and by extension, the tradeoff between throughput and resume granularity:

- **Backfill** — source emits `StateMessage` every N thousand records. The destination batches large commits. On crash, at most N thousand records are re-synced.

- **Live / webhooks** — source emits `StateMessage` after every record. The destination flushes immediately. On crash, at most one record is re-synced.

No phase hint or mode switch is needed. The source naturally adjusts checkpoint frequency based on its own context.

### Backfill → live transition

The source handles the transition internally. From the orchestrator's perspective, there is one `read()` call that starts finite (backfill) and becomes infinite (live). The source notes the timestamp when backfill started and ensures the live phase picks up from that point with overlap. Duplicates are deduped at the destination via `primary_key`.

```
source.read(streams)
  → RecordMessage  (backfill)
  → RecordMessage  (backfill)
  → ...
  → StateMessage   {stream: "customers", data: {phase: "live", cursor: "2026-03-17T00:00:00Z"}}
  → RecordMessage  (live)
  → RecordMessage  (live)
  → ...            (infinite)
```

### Beyond the pipe

The orchestrator is also responsible for:

- **Reconciliation** — periodically re-scan to fill gaps from missed events
- **Scheduling** — manage multiple syncs in the platform runtime
- **Graceful shutdown** — stop reading, let the destination flush

## Storage

The engine has two storage concerns:

| What                                                      | Storage                                      | Why                                                    |
| --------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------ |
| **Config** (Sync, SourceConfig, DestinationConfig, state) | Database                                     | Relational, queried frequently, needs transactions     |
| **Secrets** (API keys, passwords, OAuth tokens)           | Secret store (referenced by `credential_id`) | Security isolation — deployment access ≠ secret access |

State is stored on the Sync resource itself (`Sync.state`) — a per-stream checkpoint map managed by the orchestrator. On each confirmed `StateMessage` from the destination, the orchestrator merges the checkpoint into `Sync.state[stream]` and persists the Sync. On resume, it passes the full map to the source:

```typescript
const messages = source.read(catalog.streams, sync.state)
// sync.state = { customers: {"after":"cus_999"}, invoices: {"after":"inv_500"}, ... }
```

The source uses the map to resume each stream from its last checkpoint.

## Files

| File                   | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| `sync-engine-types.ts` | Message protocol — Stream, Record, State, etc.            |
| `sync-engine-api.ts`   | Interfaces — Source, Destination, Transform, Orchestrator |
| `ARCHITECTURE.md`      | This document                                             |
