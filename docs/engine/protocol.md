# Protocol

A simplified version of the [Airbyte Protocol](https://docs.airbyte.com/understanding-airbyte/airbyte-protocol),
mostly compatible, optimized for real-time streams.

## What we kept

The core ideas are the same:

- **Message types** — `record`, `state`, `catalog`, `log`, `error`. Discriminated by `type`, serialized as NDJSON.
- **Source / Destination** — connectors implement `spec`, `check`, `discover`, `read` (source) or `write` (destination).
- **Configured catalog** — user selects streams from the discovered catalog, sets `sync_mode` (full_refresh / incremental) and `destination_sync_mode` (append / overwrite / append_dedup).
- **State checkpoints** — source emits `StateMessage` between records. Destination re-emits after committing. Orchestrator persists for resume.
- **NDJSON wire format** — one JSON object per line. Works for both in-process async iterators and subprocess stdin/stdout pipes.

If you've built an Airbyte connector, the mental model transfers directly.

## What we simplified

### Always per-stream state

Airbyte has three state modes: global, per-stream, and per-stream-per-partition. We only have per-stream.

State is a flat `Record<string, TStreamState>` map keyed by stream name. No mode negotiation, no partition keys.

```ts
// Airbyte: array of state messages with type/stream_descriptor/global discriminators
[
  { type: "STREAM", stream_descriptor: { name: "customer", namespace: "public" }, stream_state: { cursor: "..." } },
  { type: "GLOBAL", global: { shared_state: { cdc_lsn: "..." }, stream_states: [...] } }
]

// Ours: flat map
{ customer: { cursor: "cus_999" }, invoice: { cursor: "inv_500" } }
```

### No namespace

Airbyte uses `namespace` (typically a database schema) alongside stream name. We use `Stream.metadata` instead — a generic bag where sources put whatever context applies (`schema`, `database`, `api_version`, `account_id`, etc.).

### No control/trace messages

Airbyte has `AirbyteControlMessage` (connector version upgrades, config updates) and `AirbyteTraceMessage` (structured traces with timing). We fold both into `LogMessage` and `ErrorMessage` with `level` and `failure_type` discriminators. Fewer message types, same information.

### No connector version negotiation

Airbyte connectors declare a protocol version and the platform negotiates compatibility. We skip this — connectors are in-process TypeScript modules with compile-time type checking. Subprocess connectors use the same NDJSON format without version headers.

### Engine is a pure function

Airbyte's orchestrator is a platform service (Temporal workflows, Kubernetes pods, connection manager). Our engine is a pure function:

```ts
async function* runSync(config, source, destination): AsyncIterable<StateMessage>
```

No database, no filesystem, no module discovery. The caller imports source and destination explicitly. Platform concerns (scheduling, state persistence, retries) live in the orchestrator layer above.

## What we added for real-time

### Infinite reads

Airbyte's `read` is always finite — it runs, emits records, exits. Our `read()` returns `AsyncIterable<Message>` which can be:

- **Finite** — backfill, same as Airbyte. Read all records, emit state, done.
- **Infinite** — live/streaming. Webhooks, CDC, WebSocket, event bridge. The iterator never returns.

Same interface, same message types. The source decides the duration. A source can even transition from finite to infinite mid-stream (backfill then live).

### Event-driven input (`input` parameter)

Real-time sources come in two flavors:

| Pattern                  | Example                 | Who manages the connection       | `read()` behavior             |
| ------------------------ | ----------------------- | -------------------------------- | ----------------------------- |
| **Encapsulated**         | WebSocket, CDC, polling | Source opens and manages it      | Infinite iterator, no `input` |
| **Inversion of control** | Webhooks                | External system pushes events in | Called per-event with `input` |

Airbyte only supports the encapsulated pattern. We support both through a single `read()` method:

```ts
// Encapsulated: source manages its own WebSocket connection
source.read({ config, catalog, state }) // infinite iterator

// Inversion of control: orchestrator receives webhook, passes payload in
source.read({ config, catalog, state, input: webhookEvent }) // finite, one event
```

`ConnectorSpecification.input` declares the JSON Schema for the event payload, so the orchestrator can validate webhook bodies before passing them to the source.

### `setup()` / `teardown()` lifecycle

Live sources often need external resources provisioned before `read()` can work:

| Source type     | `setup()` provisions             | `teardown()` cleans up   |
| --------------- | -------------------------------- | ------------------------ |
| Stripe webhooks | Creates webhook endpoint via API | Deletes webhook endpoint |
| Postgres CDC    | Creates replication slot         | Drops replication slot   |
| File watcher    | Registers inotify watch          | Removes watch            |

Airbyte has no lifecycle hooks — everything happens inside `read()`. We make provisioning explicit because:

- `setup()` runs once on sync creation, not on every read
- `teardown()` runs on sync deletion, not on pause (so resume is instant)
- Multiple syncs can share a resource (e.g. one webhook endpoint per Stripe account) — `teardown()` checks for other active consumers before deleting

Both methods are optional. Pull-based sources (REST API polling) don't need them.

### Stream metadata

Airbyte uses `namespace` for one piece of source context (typically a schema name). We use `Stream.metadata` for arbitrary source-specific fields:

```ts
// Stripe source
{ api_version: "2025-04-30.basil", account_id: "acct_123", live_mode: true }

// Postgres source
{ schema: "public", database: "mydb" }
```

Destinations can use metadata for schema naming, partitioning, routing, etc.

### Composable transforms

A `Transform` is `(messages: AsyncIterable<Message>) => AsyncIterable<Message>`. Transforms compose with `compose(a, b, c)` (left-to-right piping) and can filter, map, buffer, or aggregate messages between source and destination.

Airbyte has no transform concept — all transformation happens inside the destination or in a separate dbt step.

### In-process first

Airbyte connectors are Docker containers communicating via stdin/stdout. Our connectors are TypeScript modules with typed interfaces:

```ts
import source from '@stripe/sync-source-stripe'
import destination from '@stripe/sync-destination-postgres'

for await (const state of runSync(config, source, destination)) {
  persist(state)
}
```

Subprocess mode is an adapter layer — the same NDJSON protocol, but the primary path is in-process async iterators with full type safety.

## Compatibility

The protocol is a **subset** of Airbyte's message vocabulary with **extensions** for real-time. Wrapping an Airbyte connector requires:

1. **Messages** — rename `type` values (`RECORD` → `record`, etc.) and flatten the envelope (Airbyte wraps every message in `{ type: "...", record: { ... } }`; we use flat discriminated unions).
2. **State** — convert from Airbyte's `AirbyteStateMessage` array to our `Record<string, unknown>` map.
3. **Catalog** — field names are nearly identical (`stream_name` → `name`, add `primary_key`).
4. **Spec/Check** — trivial mapping.

The reverse direction (wrapping our connector for Airbyte) is equally straightforward since we're a subset of their message types.
