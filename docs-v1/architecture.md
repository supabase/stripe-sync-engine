---
theme: default
title: Sync Engine Architecture
transition: slide-left
mdc: true
---

# Sync Engine Architecture

A transport-agnostic pipeline for syncing Stripe data to any destination

---

## Why This Architecture?

<Transform :scale="0.85">

```mermaid
flowchart LR
  P1["Problem: many destinations\nPostgres, Sheets, Kafka…"]
  P2["Problem: 16 webhook\nendpoints per account"]
  P3["Problem: local CLI today\nTemporal workflow tomorrow"]
  P1 -->|solution| S1["Protocol layer\ninterchangeable connectors"]
  P2 -->|solution| S2["Fan-out inside service\n1 endpoint → N syncs"]
  P3 -->|solution| S3["Transport-agnostic pipeline\nswap transport, keep connectors"]
  style P1 fill:#fee2e2,stroke:#ef4444
  style P2 fill:#fee2e2,stroke:#ef4444
  style P3 fill:#fee2e2,stroke:#ef4444
  style S1 fill:#dcfce7,stroke:#22c55e
  style S2 fill:#dcfce7,stroke:#22c55e
  style S3 fill:#dcfce7,stroke:#22c55e
```

</Transform>

---

## Three-Layer Stack

```
┌─────────────────────────────────────────────────┐
│  packages/stateful-sync  (service)              │
│  StatefulSync · stores · fan-out queues         │  ← adds persistence
├─────────────────────────────────────────────────┤
│  packages/stateless-sync  (engine)              │
│  createEngine() · connector loader              │  ← wires the pipeline
│  NDJSON streaming · CLI helpers                 │
├─────────────────────────────────────────────────┤
│  packages/protocol                              │
│  Source<TConfig, TState, TInput>                │  ← what connectors implement
│  Destination<TConfig, TState>                   │
└─────────────────────────────────────────────────┘
```

Each layer only knows about the layer below it.
Connectors only know about `protocol` — nothing about persistence or transport.

---

## layout: two-cols

## The Protocol Contract

```ts
interface Source<TConfig, TState, TInput = never> {
  spec():    ConnectorSpecification
  check():   Promise<CheckResult>
  discover(): Promise<ConfiguredCatalog>
  setup():   Promise<void>
  read(params, $stdin?): AsyncIterable<Message>
  teardown({ remove_shared_resources? }): Promise<void>
}

interface Destination<TConfig, TState> {
  spec():   ConnectorSpecification
  setup():  Promise<void>
  write(messages): AsyncIterable<StateMessage>
}
```

`Message` = `RecordMessage | StateMessage | ErrorMessage`

::right::

<br/><br/>

```mermaid
flowchart TD
  SRC["Source"]
  DST["Destination"]
  SRC -->|"AsyncIterable&lt;Message&gt;"| DST
  DST -->|"AsyncIterable&lt;StateMessage&gt;"| ST["state checkpoints"]
  style SRC fill:#dcfce7,stroke:#22c55e
  style DST fill:#dbeafe,stroke:#3b82f6
  style ST fill:#fef9c3,stroke:#eab308
```

State flows **as messages** — connectors never touch a DB directly.

---

## layout: two-cols

## Message Protocol

The pipeline speaks **NDJSON** — one message per line.

```ts
// Source → Engine: full union
type Message =
  | RecordMessage // a record to write
  | StateMessage // cursor checkpoint
  | CatalogMessage // stream discovery
  | LogMessage // diagnostic output
  | ErrorMessage // structured failure
  | StreamStatusMessage // progress update

// Engine → Destination: filtered down
type DestinationInput = RecordMessage | StateMessage // engine strips the rest
```

The engine is the filter. Destinations never see logs,
errors, or status messages — only data and checkpoints.

::right::

```ts
type RecordMessage = {
  type: 'record'
  stream: string // target table / stream
  data: Record<string, unknown>
  emitted_at: number // epoch ms
}

type StateMessage = {
  type: 'state'
  stream: string // which stream's cursor
  data: unknown // opaque — only source reads this
}

type ErrorMessage = {
  type: 'error'
  failure_type: 'config_error' | 'system_error' | 'transient_error' | 'auth_error'
  message: string
  stream?: string
  stack_trace?: string
}
```

---

## The Pipeline

<Transform :scale="0.82">

```mermaid
flowchart LR
  STDIN["$stdin?"]
  SRC["source.read()"]
  ENG["Engine"]
  DST["destination.write()"]
  STATE["state store"]
  STDIN -->|"undefined → one-shot"| SRC
  STDIN -->|"iterable → live loop"| SRC
  SRC -->|"RecordMessage\nStateMessage"| ENG
  ENG --> DST
  ENG --> STATE
  style ENG fill:#dcfce7,stroke:#22c55e
  style STATE fill:#fef9c3,stroke:#eab308
```

</Transform>

| `$stdin`             | Behaviour                         |
| -------------------- | --------------------------------- |
| `undefined`          | backfill → events poll → done     |
| `AsyncIterable<...>` | skips backfill, live loop forever |

The **same interface** works locally (direct pipe) or in cloud (Temporal activities).

---

## Source-Stripe: Three Sync Modes

<Transform :scale="0.8">

```mermaid
flowchart LR
  R["source.read($stdin?)"]
  R -->|"$stdin"| EV["event-driven loop\nwebhook / WebSocket"]
  R -->|"no $stdin"| BF["listApiBackfill()\ncursor: pageCursor"]
  BF --> PO["pollEvents()\ncursor: last event ID"]
  EV --> PSE["processStripeEvent()\nentitlements · revalidation\ncatalog filter"]
  PO --> PSE
  PSE --> MSG["RecordMessage\n+ StateMessage"]
  style EV fill:#fef9c3,stroke:#eab308
  style PSE fill:#dcfce7,stroke:#22c55e
```

</Transform>

All verified `Stripe.Event` objects converge through `processStripeEvent()`.

---

## Webhook Fan-out

Stripe caps accounts at **~16 webhook endpoints**. One endpoint for all syncs.

<Transform :scale="0.82">

```mermaid
flowchart LR
  ST["Stripe"] -->|"POST /webhooks/:credential_id"| WH["Hono route"]
  WH --> PE["StatefulSync\n.push_event()"]
  PE --> QA["sync_A AsyncQueue\n[products]"]
  PE --> QB["sync_B AsyncQueue\n[products, customers]"]
  PE --> QC["sync_C AsyncQueue\n[invoices]"]
  style PE fill:#fef9c3,stroke:#eab308
  style WH fill:#dbeafe,stroke:#3b82f6
```

</Transform>

Each sync has its own `AsyncQueue` under `credential_id`.
`run()` registers on start, deregisters on stop — no leaked queues.

---

## layout: two-cols

## Stream Filtering

Filtering happens **inside the source**, not at ingress.

```ts {4}
// source-stripe/src/process-event.ts

const resourceConfig = registry[normalizeStripeObjectName(dataObject.object)]

if (!streamNames.has(resourceConfig.tableName)) return
//  ↑ the filter
```

`streamNames` built at `read()` startup:

```ts
const streamNames = new Set(catalog.streams.map((s) => s.stream.name))
```

::right::

<br/>

```mermaid
flowchart TD
  E["customer.updated"]
  E --> A["sync_A\n{products}"]
  E --> B["sync_B\n{products, customers}"]
  A -->|"not in set"| X["✗  nothing written"]
  B -->|"in set"| Y["✓  record + state"]
  style X fill:#fee2e2,stroke:#ef4444
  style Y fill:#dcfce7,stroke:#22c55e
  style E fill:#dbeafe,stroke:#3b82f6
```

---

## Stateful API

<Transform :scale="0.82">

```mermaid
flowchart LR
  C["POST /credentials"] --> CS[("credentials.json")]
  SY["POST /syncs"] --> SS[("syncs.json")]
  RN["POST /syncs/:id/run"] --> SVC["StatefulSync.run()\nstreaming NDJSON"]
  WH["POST /webhooks/:cred_id"] --> PE["push_event()\nfan-out to queues"]
  style RN fill:#dcfce7,stroke:#22c55e
  style WH fill:#fef9c3,stroke:#eab308
```

</Transform>

Schemas are built **dynamically at startup** from registered connectors.
Credential and sync schemas become discriminated unions over registered connector types.

---

## Destination: Postgres

<Transform :scale="0.82">

```mermaid
flowchart LR
  EV["Stripe Event"] --> PSE["processStripeEvent()"]
  PSE --> RM["RecordMessage"]
  RM --> DW["destination.write()"]
  DW --> DB[("UPSERT\nschema.stream\nid PK · _raw_data JSONB")]
  DW --> SM["StateMessage"]
  SM --> ST[("state.json")]
  style DB fill:#dbeafe,stroke:#3b82f6
  style SM fill:#dcfce7,stroke:#22c55e
```

</Transform>

- Schema per sync — complete isolation between syncs
- `_raw_data` stores the full Stripe object; typed columns via generated columns
- Tables created on first write — no migration step required

---

## Key Design Decisions

**`$stdin` as the seam**
`undefined` → one-shot backfill. Infinite async iterable → live event loop.
Same `Source` interface handles both. No protocol changes needed for webhooks.

**Stateless / Stateful split**
`cli` + `api` = one-shot, caller provides everything, no memory between calls.
`service` = persistent cursors, credential store, lifecycle management.

**`remove_shared_resources` on teardown**
Service checks whether other syncs share the credential before deleting
the webhook endpoint — prevents one sync from breaking its siblings.

**Connector isolation**
Connectors implement `protocol` only. They have no knowledge of stores,
queues, HTTP routes, or cloud infrastructure. Swap the transport; keep the connector.
