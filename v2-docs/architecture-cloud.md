# Cloud Deployment Architecture

## Overview

```
                      +--------------+
                      |  API Server  |  CRUD: credentials, syncs
                      |  (apps/api)  |  Starts Temporal workflows
                      +------+-------+
                             |
                             | POST /syncs
                             |   1. db.syncs.insert(sync)
                             |   2. temporal.client.start(SyncWorkflow, { args: [sync] })
                             v
+--------------------------------------------------------------------+
|                       Temporal Server                               |
|                                                                     |
|  Long-running workflows (one per sync)                             |
|  +------------------+ +------------------+ +------------------+     |
|  | SyncWorkflow     | | SyncWorkflow     | | SyncWorkflow     |     |
|  | sync_abc         | | sync_def         | | sync_ghi         |     |
|  |                  | |                  | |                  |     |
|  | setup → backfill | | setup → backfill | | setup → backfill |     |
|  | → monitor loop   | | → monitor loop   | | → monitor loop   |     |
|  | (sleep 5m)       | | (sleep 5m)       | | (sleep 5m)       |     |
|  +------------------+ +------------------+ +------------------+     |
+--------------------------------------------------------------------+
                             |
                             | activities
                             v
+---------------+     +------------+          +------------------+
| Temporal      |---->|            |          |                  |
| Workers       |     | Sync       | -------> |                  |
+---------------+     | Engine     | produce  |   K A F K A      |
                      | Source     |          |                  |
+---------------+     |            |          |  topic:          |
| Webhook       |---->| source     |          |  sync-messages   |
| Ingress       |     | .read()    |          |                  |
| (stateless)   |     |            |          |  key = sync_id   |
+---------------+     +------------+          |                  |
       ^         state = cursors (backfill)   +--------+---------+
       |           or webhook body (live)              |
  Stripe                                               | consume
                                                       v
                                              +------------------+
                                              | Destination      |
                                              | Workers          |
                                              |                  |
                                              | partition 0 > pg |
                                              | partition 1 > pg |
                                              | partition 2 > gs |
                                              +------------------+
```

## Sync lifecycle

The API server owns sync CRUD. Temporal runs a long-running workflow per sync.

### Create

```
POST /syncs
  1. db.syncs.insert(sync)
  2. temporal.client.start(SyncWorkflow, { args: [sync] })
```

Simple ordering: DB first, then start the workflow. If step 2 fails, the sync exists in DB but has no workflow — the API can retry or an operator can re-trigger.

### Pause / Resume

```
PUT /syncs/:id/pause    → temporal.signal(syncId, 'pause')
PUT /syncs/:id/resume   → temporal.signal(syncId, 'resume')
```

### Delete

```
DELETE /syncs/:id
  1. temporal.signal(syncId, 'delete')   // workflow tears down, then completes
  2. db.syncs.delete(syncId)
```

Signal first so the workflow runs teardown (webhook cleanup, etc.) before completing. Then remove the DB record.

> **Note:** An optional reconciliation process can periodically compare DB records against running Temporal workflows to catch drift (e.g., a workflow that crashed without completing teardown). This is a nice-to-have, not a core requirement — Temporal's retry and durability guarantees handle the common cases.

## Message flow

Two paths produce messages. Both call `source.read(config, catalog, state)` — the only difference is what `state` contains.

`state` is a map: `Record<stream_name, cursor | webhook_body>`. For backfill, cursors track pagination position. For live, the webhook body is the state.

### Path 1: Backfill (Temporal → Source → Kafka)

The workflow runs a backfill activity. The worker calls `source.read()` with cursor state, which paginates historical data and produces records to Kafka:

```
Temporal activity: runBackfill(sync)
  → source.read(config, catalog, state)   // state = { customer: { after: "cus_xxx" } }
  → for await (msg of forward(messages))
      kafka.produce('sync-messages', key=syncId, value=msg)
  → commit final state checkpoint (updated cursors)
```

Backfill is a finite operation. When it completes, the workflow enters the monitor loop.

### Path 2: Live (Webhook → Source → Kafka)

The webhook ingress server receives Stripe events, resolves matching syncs, and calls `source.read()` with the webhook body as state:

```
POST /webhooks
  → verify Stripe signature
  → extract account_id + object type (e.g. "customer")
  → lookup matching syncs from routing table
  → for each matching sync:
      source.read(config, catalog, state)  // state = { customer: { webhook: event } }
      → for await (msg of forward(messages))
          kafka.produce('sync-messages', key=sync_id, value=msg)
  → return 200
```

Both paths use the same `source.read()` → `forward()` → `kafka.produce()` pipeline. The Source normalizes records regardless of whether state contains a cursor (backfill) or a webhook body (live).

### Consumer (Kafka → Destination)

Destination workers form a Kafka consumer group. Each worker pulls from assigned partitions and writes to the destination:

```
kafka.consume('sync-messages', group='destination-workers')
  → destination.write({ config, catalog }, messages)
  → on StateMessage: commit Kafka offset + persist checkpoint
```

## Kafka topic design

**Topic**: `sync-messages`

**Key**: `sync_id` (e.g. `sync_abc123`)

**Value**: JSON-encoded `DestinationInput` (`RecordMessage | StateMessage`)

**Partitioning**: Kafka hashes the key to assign a partition. All messages for the same `sync_id` land on the same partition.

**Ordering guarantee**: messages within a partition are strictly ordered. Since all messages for a sync share a partition, ordering per sync is guaranteed.

**Consumer group**: one consumer per partition. Since all messages for a sync are on one partition, at most one consumer processes a given sync at any time. No distributed locking needed.

```
sync_abc --+
sync_def --+--> partition 0 --> consumer 0 (destination worker)
           |
sync_ghi --+--> partition 1 --> consumer 1 (destination worker)
           |
sync_jkl --+--> partition 2 --> consumer 2 (destination worker)
```

Note: multiple sync_ids may hash to the same partition. This means one consumer may handle multiple syncs, but each sync is still processed by exactly one consumer. If a sync is particularly hot, it doesn't affect other syncs on different partitions.

## Temporal workflow

One **long-running workflow** per sync. The workflow receives the full sync config as its argument, runs setup + backfill, then enters a monitor loop that sleeps and health-checks until signaled.

### Workflow

```ts
async function SyncWorkflow(sync: SyncConfig) {
  let paused = false
  let deleted = false

  // Signal handlers
  setHandler(pauseSignal, () => {
    paused = true
  })
  setHandler(resumeSignal, () => {
    paused = false
  })
  setHandler(deleteSignal, () => {
    deleted = true
  })

  // 1. Provision (idempotent)
  await activities.sourceSetup(sync)
  await activities.destinationSetup(sync)

  // 2. Backfill (resumes from state checkpoint)
  await activities.runBackfill(sync)

  // 3. Monitor loop
  let iterations = 0
  while (!deleted) {
    await sleep('5m')

    if (paused) continue

    // Health check + incremental work
    const health = await activities.checkHealth(sync)
    if (health.webhookMissing) {
      await activities.sourceSetup(sync) // re-register
    }

    // Check DB for config changes
    const latest = await activities.getSyncFromDB(sync.id)
    if (!latest) {
      deleted = true
      break
    }
    sync = latest

    // Avoid unbounded history
    if (++iterations > 500) {
      await continueAsNew(sync)
    }
  }

  // 4. Teardown on delete
  await activities.sourceTeardown(sync)
  await activities.destinationTeardown(sync)
}
```

Config is passed as a workflow argument — no DB lookup needed on startup, avoiding a race between workflow start and DB write. The monitor loop periodically checks DB for config updates and detects external deletion.

`continueAsNew` every ~500 iterations prevents Temporal history from growing unboundedly.

### Activities

| Activity              | What it does                                                                  | Idempotent               |
| --------------------- | ----------------------------------------------------------------------------- | ------------------------ |
| `sourceSetup`         | Register webhook, create replication slot, etc.                               | Yes                      |
| `destinationSetup`    | Create schema, tables, spreadsheet tabs, etc.                                 | Yes                      |
| `runBackfill`         | `source.read()` → `forward()` → produce to Kafka. Heartbeats cursor position. | Yes (resumes from state) |
| `checkHealth`         | Verify webhook active, consumer lag, error rate                               | Yes (read-only)          |
| `getSyncFromDB`       | Load latest sync config from DB                                               | Yes (read-only)          |
| `sourceTeardown`      | Delete webhook (if last sync for account), drop replication slot              | Yes                      |
| `destinationTeardown` | Optional cleanup (drop schema, etc.)                                          | Yes                      |

All activities are idempotent. Temporal can retry any of them safely.

## Components

### API Server (`apps/api`)

- CRUD for credentials and syncs (DB)
- On sync create:
  1. `db.syncs.insert(sync)`
  2. `temporal.client.start(SyncWorkflow, { args: [sync] })`
- On sync pause: `temporal.signal(syncId, 'pause')`
- On sync resume: `temporal.signal(syncId, 'resume')`
- On sync delete:
  1. `temporal.signal(syncId, 'delete')` (workflow runs teardown, then completes)
  2. `db.syncs.delete(syncId)`
- Stateless. Horizontally scalable.

### Webhook Ingress

- Fastify/Hono HTTP server
- Validates Stripe webhook signatures
- Resolves `account_id` + event type → matching syncs (from routing table)
- Calls `source.read()` with webhook payload to normalize events into records
- Produces normalized records to Kafka (one message per matching sync)
- Returns 200 immediately
- Stateless. Horizontally scalable behind a load balancer.
- No destination logic — ingestion + normalization + fan-out.

### Temporal Workers

- Run Temporal activities (backfill, setup, teardown, health checks)
- Call `source.read()`, `source.setup()`, `source.teardown()` via Sync Engine
- Produce backfill records to Kafka through the same `source.read()` → `forward()` → `produce()` pipeline
- Horizontally scalable (Temporal distributes activities across workers)

### Destination Workers

- Kafka consumer group (`destination-workers`)
- Each worker consumes from assigned partitions
- Calls `destination.write()` with messages from Kafka
- Commits Kafka offsets after successful write + state checkpoint
- Horizontally scalable (up to number of partitions)

### Kafka

- Single topic: `sync-messages`
- Partitions: start with N (e.g. 32), increase as syncs grow
- Retention: configured per use case (e.g. 7 days for replay capability)
- Key compaction not needed — messages are consumed and state is checkpointed externally

### DB

- Stores: credentials, sync configs, state checkpoints, routing table
- Source of truth for "does this sync exist?"
- Used by: API server (config CRUD), Temporal workers (sync lookup), destination workers (state persistence)

### Temporal Server

- Manages workflow executions (one long-running workflow per sync)
- Uses its own persistence (Postgres or Cassandra)
- No application data in Temporal — it's purely the execution engine

## Routing table

Stored in DB. Derived from sync configs. Rebuilt when syncs are created, updated, or deleted.

```sql
CREATE TABLE sync_routes (
  sync_id    TEXT NOT NULL,
  account_id TEXT NOT NULL,
  stream_name TEXT NOT NULL
);
CREATE INDEX idx_sync_routes_lookup ON sync_routes (account_id, stream_name);
```

The webhook ingress queries this on every request:

```sql
SELECT sync_id FROM sync_routes WHERE account_id = $1 AND stream_name = $2
```

This is a hot-path read. Cache in-memory with short TTL or use DB change notifications for invalidation.

## State and checkpoints

State flows through the system:

```
source.read() emits StateMessage (cursor position)
  → produced to Kafka as a regular message
  → destination worker receives it
  → destination.write() flushes pending records, re-emits StateMessage
  → worker persists checkpoint to DB: UPDATE syncs SET state = $1 WHERE id = $2
  → worker commits Kafka offset
```

On crash recovery:

1. Kafka consumer restarts from last committed offset
2. Some messages may be reprocessed (at-least-once delivery)
3. Destination upserts are idempotent (keyed by primary key) — duplicates are harmless
4. Backfill resumes from last persisted state checkpoint

## Scaling properties

| Component           | Scaling                               | Bottleneck                   |
| ------------------- | ------------------------------------- | ---------------------------- |
| API Server          | Horizontal (stateless)                | DB connections               |
| Webhook Ingress     | Horizontal (stateless)                | Kafka producer throughput    |
| Temporal Workers    | Horizontal (Temporal distributes)     | Source API rate limits       |
| Kafka               | Add partitions                        | Disk I/O, network            |
| Destination Workers | Horizontal (up to # partitions)       | Destination write throughput |
| DB                  | Horizontal (read replicas / sharding) | Write throughput             |

**Key scaling constraint**: number of Kafka partitions determines max consumer parallelism. Start with more partitions than syncs (e.g. 32 or 64) to allow growth without repartitioning.

## Docker Compose (development)

```yaml
services:
  postgres:
    image: postgres:16
    ports: ['5432:5432']
    environment:
      POSTGRES_PASSWORD: postgres

  kafka:
    image: bitnami/kafka:latest
    ports: ['9092:9092']
    environment:
      KAFKA_CFG_NODE_ID: 0
      KAFKA_CFG_PROCESS_ROLES: controller,broker
      KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: 0@kafka:9093
      KAFKA_CFG_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      KAFKA_CFG_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_CFG_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT

  temporal:
    image: temporalio/auto-setup:latest
    ports: ['7233:7233']
    environment:
      DB: postgres12
      DB_PORT: 5432
      POSTGRES_USER: postgres
      POSTGRES_PWD: postgres
      POSTGRES_SEEDS: postgres
    depends_on: [postgres]

  temporal-ui:
    image: temporalio/ui:latest
    ports: ['8080:8080']
    environment:
      TEMPORAL_ADDRESS: temporal:7233
    depends_on: [temporal]
```

## Migration path from local dev

| Local (plan-003)                  | Cloud (this doc)                        |
| --------------------------------- | --------------------------------------- |
| Postgres `_queue` table           | Kafka topic                             |
| In-process reconcile loop         | Temporal long-running workflow per sync |
| `PgQueue.push()`                  | `kafka.produce()`                       |
| `PgQueue[Symbol.asyncIterator]()` | Kafka consumer                          |
| `AbortController` for pause       | Temporal signal                         |
| Single process                    | Independent scalable services           |

The `produce()` / `consume()` split from plan-003 maps directly: the producer writes to Kafka instead of Postgres, the consumer reads from Kafka instead of Postgres. The `Source` and `Destination` interfaces are unchanged.
