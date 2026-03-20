# Idea: Temporal workflow-per-destination

## Context

Plan-003 introduced a Postgres queue between source and destination and deferred
Temporal as unnecessary for a small number of syncs. This idea revisits Temporal
now that the architecture has matured, specifically the pattern of **one
long-running workflow per destination** where sources send data into the workflow
directly via Temporal signals — no separate queue infrastructure.

## The core idea

Each sync destination becomes a durable Temporal workflow. Sources push data into
it via **signals** rather than inserting into a queue table. The workflow
accumulates signals, batches them, and flushes to the destination via activities.

```
Webhook handler ──signal(event)──▶ ┌─────────────────────────┐
                                   │  DestinationWorkflow     │
Backfill worker ──signal(page)───▶ │  - buffers signals       │──activity──▶ Postgres
                                   │  - flushes on batch/timer│
Stripe events   ──signal(event)──▶ │  - checkpoints state     │
                                   └─────────────────────────┘
```

Temporal's signal buffer is implicitly a durable queue — but collocated with
workflow state rather than a standalone service. "No queue" really means "no
separate queue to operate."

## How it maps to existing data paths

### Webhook ingestion (push) — clean fit

Today `stripe-webhook.ts` does the full `source.read() → destination.write()`
synchronously inside the HTTP handler. The handler can't return 200 until
Postgres commits.

With Temporal: webhook handler validates signature, fires a signal, returns 200
immediately. The workflow processes signals at its own pace.

```ts
// Webhook handler (fast, fire-and-forget)
app.post('/webhook', async (req) => {
  const event = stripe.webhooks.constructEvent(req.body, sig, secret)
  await workflowHandle.signal(ingestSignal, { event })
  return { received: true }
})

// Destination workflow (long-running)
async function destinationWorkflow(config: SyncConfig) {
  const buffer: StripeEvent[] = []

  setHandler(ingestSignal, (payload) => {
    buffer.push(payload.event)
  })

  while (true) {
    await condition(() => buffer.length >= BATCH_SIZE, FLUSH_INTERVAL)
    if (buffer.length > 0) {
      const batch = buffer.splice(0, buffer.length)
      await writeBatch(batch)  // activity: upsert to destination
    }
  }
}
```

### Backfill (pull) — different shape

Backfill is inherently pull-based: paginate through Stripe's list API. This
doesn't naturally fit the "signal data into a workflow" model. Two options:

**Option A: Backfill as a separate workflow that signals the destination workflow**

```
BackfillWorkflow(stream) ──signal(page)──▶ DestinationWorkflow
  for each page:
    records = await fetchPage(cursor)    // activity
    await destHandle.signal(ingestSignal, { records })
    cursor = records[records.length - 1].id
```

Pro: destination workflow is the single write path for both backfill and live.
Con: two workflows coordinating via signals adds complexity.

**Option B: Backfill as activities within the destination workflow**

```ts
async function destinationWorkflow(config: SyncConfig) {
  // Phase 1: backfill
  for (const stream of config.streams) {
    let cursor: string | undefined
    while (true) {
      const page = await fetchPage(stream, cursor)  // activity
      await writeBatch(page.records)                 // activity
      if (!page.hasMore) break
      cursor = page.cursor
    }
  }

  // Phase 2: live (signals)
  while (true) {
    await condition(() => buffer.length > 0, FLUSH_INTERVAL)
    // ... same as above
  }
}
```

Pro: single workflow, linear phases, simpler.
Con: backfill and live are sequential; can't process webhooks during backfill.

**Option C: Parallel backfill + live from the start**

```ts
async function destinationWorkflow(config: SyncConfig) {
  // Signal handler accumulates from the start — even during backfill
  const buffer: Record[] = []
  setHandler(ingestSignal, (payload) => buffer.push(...payload.records))

  // Backfill and live flush run concurrently
  // Backfill feeds into the same buffer
  await Promise.all([
    backfillAllStreams(config),  // child workflow or loop of activities
    flushLoop(buffer),          // periodic flush of accumulated signals
  ])
}
```

This is probably the right answer — webhooks can arrive during backfill and
they'll be buffered and flushed alongside backfill pages.

## What Temporal buys over current AsyncIterable pipeline

| Concern                | Current (AsyncIterable)                        | Temporal workflow                                |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------ |
| **Crash recovery**     | Restart from last StateMessage checkpoint       | Workflow replays from event history automatically |
| **State persistence**  | Manual: `states.set(syncId, stream, data)`      | Implicit: workflow local state survives crashes   |
| **Retry**              | Hand-rolled try/catch + loop                    | Declarative activity retry policies               |
| **Backpressure**       | Async iterator pull (blocks source if dest slow)| Signal buffer (source returns immediately)        |
| **Visibility**         | Custom status fields + logs                     | Temporal UI: workflow state, signal history, timeline |
| **Webhook latency**    | Handler blocked until destination commits       | Handler returns immediately after signal          |
| **Batching**           | Destination-internal (batch_size=100)           | Workflow-level: `condition()` + timer             |
| **Multi-destination**  | Not supported (one pipeline = one destination)  | One signal fans out to N destination workflows    |

## What it costs

- **Temporal Server** — needs a cluster (self-hosted or Temporal Cloud). Heavy
  operational dependency for what's currently a lightweight pipeline.
- **Continue-as-new** — long-running workflows accumulate event history. Must
  periodically `continueAsNew()` to shed history. Adds complexity.
- **Signal payload limits** — ~2MB per signal. Large records or batched pages
  may need chunking.
- **Latency** — signal dispatch → workflow task → activity dispatch adds
  milliseconds vs. direct in-process pipeline.
- **Supabase incompatibility** — Deno edge functions can't run Temporal workers.
  The Supabase deployment path would need a separate solution.
- **Testing** — Temporal's test framework (workflow replay, time skipping) is
  powerful but has a learning curve vs. current unit tests with mock sources.

## Observation: Supabase already does this pattern

The Supabase backfill worker (`stripe-backfill-worker.ts`) is structurally the
same idea, implemented with edge function self-reinvocation instead of Temporal:

| Temporal concept        | Supabase equivalent                              |
| ----------------------- | ------------------------------------------------ |
| Workflow                | Chain of edge function invocations                |
| Workflow state          | Cursor + status rows in `_sync_state` table       |
| Activity                | One edge function invocation (fetch page + write) |
| Continue-as-new         | Self-reinvocation via `fetch()` to own URL         |
| Signal                  | Webhook edge function writes directly              |
| Completion barrier      | `NOT EXISTS` query across all stream statuses      |

Temporal would formalize this with durable execution instead of the
self-reinvocation hack, but the conceptual model is the same.

## When this makes sense

- **Multi-destination fan-out** — one Stripe account syncing to Postgres AND
  Google Sheets AND a data warehouse. One webhook signal fans out to three
  workflow instances.
- **Complex lifecycle** — pause/resume, schema migrations, rate limit
  coordination across streams.
- **Operational visibility** — Temporal UI replaces custom dashboards for sync
  status.
- **Scale** — hundreds of concurrent syncs where the reconciler + queue model
  becomes hard to reason about.

## When it doesn't

- **Single sync, single destination** — the AsyncIterable pipeline is simpler
  and has zero infrastructure overhead.
- **Serverless/edge deployments** — Temporal workers need long-running processes.
- **Prototype/MVP phase** — adding Temporal before the sync model stabilizes
  locks in workflow schemas that are expensive to migrate.

## Relationship to plan-003

Plan-003's Postgres queue + reconciler is the right intermediate step. The
`produce()`/`consume()` split maps cleanly onto Temporal later:

- `produce()` → backfill activity (or separate workflow that signals)
- `consume()` → destination workflow's flush loop
- `PgQueue` → replaced by Temporal's signal buffer
- Reconciler → replaced by Temporal's workflow scheduling

The migration path is: queue → Temporal, not AsyncIterable → Temporal.
