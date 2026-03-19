# Plan: Decoupled producer/consumer with Postgres queue

## Context

The sync pipeline is tightly coupled via in-process async iterators:

```
source.read() --async iter--> forward() --async iter--> destination.write()
```

Producer and consumer run in lock-step. If the destination is slow, the source blocks. For webhook ingestion this is fatal: Stripe expects a fast 200 response, but `destination.write()` might be slow (Postgres insert, Google Sheets API, etc.).

We need to decouple producer from consumer with a durable buffer between them.

## Architecture

```
Producer                      Postgres                    Consumer
source.read()                +----------+               destination.write()
  -> forward()  --INSERT-->  |  _queue  |  --DELETE-->    -> collect()
  -> close()                 | (JSONB)  |  SKIP LOCKED    -> persist state
                             +----------+
                                  ^
                            Reconciler (cron)
                            ensures producer + consumer
                            are running for each sync
```

### Why Postgres as the queue

- Already in docker-compose (`supabase/postgres:15` on port 54320)
- `pg` is a dependency in 4 packages already
- `FOR UPDATE SKIP LOCKED` gives us safe concurrent dequeue
- Throughput is more than sufficient for webhook event rates
- The codebase already uses this pattern (`_sync_obj_runs` in `orchestrator-postgres/stateManager.ts`)
- No new infrastructure to operate

### Why not Temporal

Temporal provides durable workflow execution, but the problems it solves — crash recovery, retry, cancellation — are already handled by:

- **Crash recovery**: `StateMessage` checkpoints + `state` on Sync. Process restarts → reload state → resume from last checkpoint.
- **Pause/resume**: `AbortController` in `FsOrchestrator`. API sets `status: paused`, reconciler checks.
- **Retries**: A try/catch + loop.
- **Visibility**: A `status` field on Sync + logs.

Temporal adds real value at scale (hundreds of concurrent workflows, complex sagas, multi-service coordination). For a handful of syncs with a checkpoint-based protocol, it's overhead. The queue + reconciler pattern can migrate to Temporal later if needed.

## Source lifecycle: `setup()` / `teardown()`

Sources that require external registration (webhooks, replication slots, topic subscriptions) need explicit lifecycle hooks. The `Source` interface gains two optional methods:

```ts
interface Source<TConfig> {
  spec(): ConnectorSpecification
  check(params: { config: TConfig }): Promise<CheckResult>
  discover(params: { config: TConfig }): Promise<CatalogMessage>
  read(params: { config: TConfig; catalog: ConfiguredCatalog; state?: StateMessage[] }): AsyncIterableIterator<Message>

  // NEW — lifecycle hooks (optional, no-op if not needed)
  setup?(params: { config: TConfig; catalog: ConfiguredCatalog }): Promise<void>
  teardown?(params: { config: TConfig }): Promise<void>
}
```

| Source type | `setup()` | `teardown()` |
|---|---|---|
| Stripe webhook | `stripe.webhookEndpoints.create()` | `stripe.webhookEndpoints.del()` |
| Postgres CDC | Create logical replication slot | Drop replication slot |
| Kafka | Subscribe to topics | Unsubscribe |
| REST polling | No-op | No-op |

The orchestrator calls `setup()` when a sync starts and `teardown()` when a sync is deleted or its last consumer stops.

## Webhook fan-out

A single Stripe webhook endpoint serves multiple syncs for the same account. The webhook handler does a fan-out INSERT:

```
webhook event arrives (account_id: acct_123, type: customer.updated)
  → lookup all syncs for acct_123 that include "customer" in their streams
  → INSERT into _queue for each matching sync_id
```

This requires a routing index derived from sync configs:

```sql
-- Materialized from syncs config, rebuilt on sync create/update/delete
CREATE TABLE _sync_routes (
  sync_id    TEXT NOT NULL,
  account_id TEXT NOT NULL,
  stream_name TEXT NOT NULL,
  PRIMARY KEY (account_id, stream_name, sync_id)
);
```

The webhook handler stays fast: validate signature, lookup routes, batch INSERT, return 200.

## Queue table

```sql
CREATE TABLE IF NOT EXISTS _queue (
  id         BIGSERIAL PRIMARY KEY,
  sync_id    TEXT NOT NULL,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS _queue_sync_id_id ON _queue (sync_id, id);
```

- **Enqueue**: `INSERT INTO _queue (sync_id, data) VALUES ($1, $2)`
- **Dequeue**: `DELETE FROM _queue WHERE id = (SELECT id FROM _queue WHERE sync_id = $1 ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING data`
- **End-of-stream**: sentinel row `{ type: "__close__" }` signals the consumer to stop
- Messages are deleted on dequeue to keep the table small

## Reconciler

A periodic loop (every N seconds) that ensures each sync has its producer and consumer running:

```ts
for (const sync of syncs.list()) {
  if (sync.status === 'backfilling' && !producers.has(sync.id)) startProducer(sync)
  if (sync.status === 'syncing'     && !consumers.has(sync.id)) startConsumer(sync)
  if (sync.status === 'paused')                                  stopAll(sync.id)
}
```

The reconciler also manages webhook lifecycle:
- First sync for an account → call `source.setup()` (registers webhook)
- Last sync for an account deleted → call `source.teardown()` (deletes webhook)
- Sync streams changed → update webhook `enabled_events`

## New package: `packages/queue`

```
packages/queue/
  package.json            # @stripe/sync-queue
  tsconfig.json
  vitest.config.ts
  src/
    index.ts              # re-exports
    pgQueue.ts            # PgQueue class
    pipeline.ts           # produce() + consume() helpers
    __tests__/
      queue.test.ts
```

### `PgQueue` class

```ts
class PgQueue {
  constructor(connectionString: string, syncId: string)

  setup(): Promise<void>           // CREATE TABLE IF NOT EXISTS
  push(msg: DestinationInput): Promise<void>          // INSERT
  pushBatch(msgs: DestinationInput[]): Promise<void>  // batch INSERT
  close(): Promise<void>           // INSERT sentinel, mark done
  pull(): Promise<DestinationInput | null>             // DELETE...SKIP LOCKED, null on sentinel
  [Symbol.asyncIterator](): AsyncIterableIterator<DestinationInput>  // poll loop
  purge(): Promise<void>           // DELETE all for sync_id
  depth(): Promise<number>         // COUNT for sync_id
  destroy(): Promise<void>         // close pool
}
```

### `produce()` / `consume()`

```ts
/** Run source, push records+state into queue, close when done. */
async function produce(source, params, queue, callbacks?): Promise<void>

/** Drain queue through destination, yield state checkpoints. */
async function* consume(destination, params, queue, callbacks?): AsyncIterableIterator<StateMessage>
```

Usage — producer and consumer run concurrently:

```ts
const queue = new PgQueue(connectionString, syncId)
await queue.setup()

const [, checkpoints] = await Promise.all([
  produce(source, { config: srcCfg, catalog }, queue),
  drain(consume(destination, { config: dstCfg, catalog }, queue)),
])
```

## Dependencies

- `@stripe/sync-protocol` — `forward()`, `collect()`, `Source`, `Destination`, message types
- `pg` — Postgres connection

## Existing code to reuse

- `forward()` / `collect()` — `packages/sync-protocol/src/filters.ts`
- `Source` / `Destination` interfaces — `packages/sync-protocol/src/interfaces.ts`
- `DestinationInput` / `StateMessage` types — `packages/sync-protocol/src/types.ts`
- `FsOrchestrator.run()` — `packages/orchestrator-fs/src/index.ts` — reference for pipeline wiring
- `findOrCreateManagedWebhook()` — `packages/source-stripe/src/stripeSyncWebhook.ts` — webhook registration logic

## Verification

```bash
docker compose up -d postgres
pnpm install
npx tsc --noEmit -p packages/queue/tsconfig.json
cd packages/queue && pnpm test
```

## Future considerations

- **LISTEN/NOTIFY** instead of polling — avoids the 50ms sleep in the consumer's pull loop
- **Batch dequeue** — pull N messages at once for throughput
- **Dead letter queue** — messages that fail processing N times move to a DLQ table
- **TTL / expiry** — auto-purge old unprocessed messages
- **Temporal migration** — if operational complexity grows, the `produce()`/`consume()` split maps cleanly onto Temporal activities within a `SyncWorkflow`
