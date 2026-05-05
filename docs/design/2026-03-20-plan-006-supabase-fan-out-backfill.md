# Design: Distributed Fan-Out Backfill for Supabase Edge Functions

## Problem

The sync engine's `source.read()` is a single async generator that sequentially paginates each stream. This doesn't work on Supabase Edge Functions:

1. **~50s timeout** — a full backfill of a large Stripe account can take minutes/hours
2. **No persistent process** — can't hold an async generator open across invocations
3. **No parallelism** — sequential stream iteration wastes time when streams are independent

The old monolith solved this with database-backed worker task queues and parallel worker threads. We need an equivalent for serverless.

## Architecture

### Overview

```
Coordinator Edge Function
  │
  │  source.discover() → ["customer", "invoice", "price", ...]
  │  INSERT INTO _sync_state (sync_id, stream, status) for each stream
  │
  │  For each stream: POST /backfill-worker { syncId, stream }
  │
  ├──► Worker: customer  ──► self-reinvoke ──► self-reinvoke ──► complete
  ├──► Worker: invoice   ──► self-reinvoke ──► complete
  ├──► Worker: price     ──► complete (small table, fits in one invocation)
  └──► Worker: product   ──► self-reinvoke ──► complete
         │
         │  all workers write directly to destination Postgres
         │  all workers update _sync_state with cursor + record count
         │
         └──► last worker detects all-done → onSyncComplete()
```

### Key principles

1. **Stream-level fan-out** — one worker chain per stream, all running in parallel
2. **Cursor-based continuation** — each invocation does a bounded chunk, saves cursor, re-invokes self
3. **Postgres is the coordination layer** — state table serves as checkpoint, progress tracker, and completion barrier
4. **No fan-in for data** — workers write directly to destination tables; Postgres upsert handles concurrency
5. **Barrier-based completion** — last worker to finish detects all-done via a single query

## State table

```sql
CREATE TABLE _sync_state (
  sync_id    text      NOT NULL,
  stream     text      NOT NULL,
  cursor     text,                          -- Stripe pagination cursor
  status     text      NOT NULL DEFAULT 'pending',  -- pending | syncing | complete | error
  records    int       NOT NULL DEFAULT 0,  -- running count of synced records
  error      text,                          -- error message if status='error'
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sync_id, stream)
);

-- Optional: sync-level tracking for the coordinator
CREATE TABLE _sync_runs (
  sync_id      text PRIMARY KEY,
  status       text NOT NULL DEFAULT 'syncing',  -- syncing | complete | partial | error
  total_streams int  NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
```

This table serves triple duty:

- **Checkpoint** — workers resume from `cursor` after timeout/failure
- **Progress** — any client can `SELECT * FROM _sync_state WHERE sync_id = ?` to see per-stream record counts and status
- **Coordination** — completion barrier query against `status`

## Worker: self-reinvocation with cursor continuation

Each worker invocation does a bounded amount of work (e.g., 5 pages × 100 records = 500 records), staying well within the ~50s timeout.

```ts
// supabase/functions/backfill-worker/index.ts
Deno.serve(async (req) => {
  const { syncId, stream } = await req.json()
  const PAGES_PER_INVOCATION = 5

  // Load cursor from state table
  const state = await db.queryRow(
    `SELECT cursor, records FROM _sync_state WHERE sync_id=$1 AND stream=$2`,
    [syncId, stream]
  )

  // Mark as syncing
  await db.query(
    `UPDATE _sync_state SET status='syncing', updated_at=now() WHERE sync_id=$1 AND stream=$2`,
    [syncId, stream]
  )

  // Paginate a bounded number of pages
  let cursor = state.cursor
  let hasMore = true
  let newRecords = 0

  for (let page = 0; page < PAGES_PER_INVOCATION && hasMore; page++) {
    const params: Record<string, unknown> = { limit: 100 }
    if (cursor) params.starting_after = cursor

    const response = await stripe.customers.list(params) // or generic list fn
    await writeBatchToDestination(stream, response.data)

    newRecords += response.data.length
    hasMore = response.has_more
    if (response.data.length > 0) {
      cursor = response.data.at(-1).id
    }
  }

  // Checkpoint: save cursor + record count
  await db.query(
    `UPDATE _sync_state
     SET cursor=$1, status=$2, records=records+$3, updated_at=now()
     WHERE sync_id=$4 AND stream=$5`,
    [cursor, hasMore ? 'syncing' : 'complete', newRecords, syncId, stream]
  )

  if (hasMore) {
    // More pages — self-reinvoke (fire-and-forget)
    fetch(`${SELF_URL}/backfill-worker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncId, stream }),
    })
  } else {
    // Stream complete — check if ALL streams are done
    await checkCompletion(syncId)
  }

  return new Response('ok')
})
```

### Timeout budget

With `PAGES_PER_INVOCATION = 5` and ~100ms per Stripe API call:

- 5 pages × (100ms API + ~50ms Postgres write) = ~750ms of actual work
- Plus overhead: ~200ms cold start, ~100ms state load/save
- Total: ~1-2s per invocation — well within 50s

Can safely increase to 20-30 pages per invocation if cold starts are the bottleneck.

## Completion fan-in: barrier pattern

No polling. No separate coordinator waiting. The workers self-coordinate:

```ts
async function checkCompletion(syncId: string) {
  // Atomic: only one worker can "claim" the completion
  const result = await db.query(
    `UPDATE _sync_runs
     SET status = 'complete', completed_at = now()
     WHERE sync_id = $1
       AND status = 'syncing'
       AND NOT EXISTS (
         SELECT 1 FROM _sync_state
         WHERE sync_id = $1 AND status NOT IN ('complete', 'error')
       )
     RETURNING *`,
    [syncId]
  )

  if (result.rowCount > 0) {
    // I'm the last worker — all streams settled
    await onSyncComplete(syncId)
  }
}
```

The `UPDATE ... WHERE ... AND NOT EXISTS(...)` is atomic — Postgres row-level locking ensures exactly one worker wins the race if two finish simultaneously.

### Error handling

If a worker fails:

```ts
try {
  // ... paginate and write ...
} catch (err) {
  await db.query(
    `UPDATE _sync_state SET status='error', error=$1, updated_at=now()
     WHERE sync_id=$2 AND stream=$3`,
    [String(err), syncId, stream]
  )
  await checkCompletion(syncId) // still check — other streams may be done
}
```

The completion check treats `error` as a terminal state (same as `complete` for fan-in purposes). `onSyncComplete` can inspect individual stream statuses to report partial success.

## Coordinator

```ts
// supabase/functions/start-backfill/index.ts
Deno.serve(async (req) => {
  const { syncId, config } = await req.json()

  // Discover streams
  const catalog = await source.discover({ config })
  const streams = catalog.streams.map((s) => s.name)

  // Initialize state table
  await db.query(`INSERT INTO _sync_runs (sync_id, total_streams) VALUES ($1, $2)`, [
    syncId,
    streams.length,
  ])
  for (const stream of streams) {
    await db.query(
      `INSERT INTO _sync_state (sync_id, stream) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [syncId, stream]
    )
  }

  // Fan out: one worker per stream (fire-and-forget)
  await Promise.all(
    streams.map((stream) =>
      fetch(`${SELF_URL}/backfill-worker`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncId, stream }),
      })
    )
  )

  return Response.json({ syncId, streams: streams.length, status: 'started' })
})
```

## Progress tracking

Since all state is in Postgres, progress is a simple query:

```sql
SELECT stream, status, records, updated_at
FROM _sync_state
WHERE sync_id = 'sync_123'
ORDER BY stream;
```

```
 stream     | status   | records | updated_at
────────────┼──────────┼─────────┼─────────────────────
 customer  | complete |   4,521 | 2024-03-20 12:34:56
 invoice   | syncing  |   1,200 | 2024-03-20 12:34:55
 price     | complete |     342 | 2024-03-20 12:34:50
 product   | pending  |       0 | 2024-03-20 12:34:45
```

A CLI or dashboard can poll this query. The Supabase real-time feature could even push updates via WebSocket.

## Relationship to existing protocol

| Protocol concept                         | Distributed equivalent                          |
| ---------------------------------------- | ----------------------------------------------- |
| `source.discover()`                      | Coordinator calls once → creates work items     |
| `source.read()` async generator          | Worker's paginate loop (bounded per invocation) |
| `StateMessage` per stream                | `_sync_state` row (cursor + records)            |
| `StreamStatusMessage` (started/complete) | `_sync_state.status` column                     |
| `destination.write()`                    | Worker calls directly per batch                 |
| `RouterCallbacks.onRecord`               | `records` counter in state table                |
| `SyncParams.streams` filter              | Worker receives single stream name              |

The protocol's `Source.read()` async generator doesn't survive across HTTP invocations. Instead, the worker does what `read()` does internally — paginate with cursor — but decomposed into bounded chunks with Postgres as the continuation mechanism. The protocol types (`RecordMessage`, `StateMessage`, `Stream`) still define the data shapes.

## Resume / idempotency

- **Worker crash mid-page**: cursor wasn't updated → next invocation re-fetches the same page → destination upserts are idempotent → no duplicates
- **Worker crash after cursor save but before self-reinvoke**: state says `syncing` with a valid cursor → a recovery sweep (cron or manual) can re-invoke stale workers
- **Coordinator crash after partial fan-out**: some streams have state rows, others don't → re-running coordinator uses `ON CONFLICT DO NOTHING` → safe to retry

### Stale worker detection

```sql
-- Find workers that stopped making progress (stale > 5 minutes)
SELECT sync_id, stream FROM _sync_state
WHERE status = 'syncing' AND updated_at < now() - interval '5 minutes';
```

A cron job can re-invoke these workers to recover from dropped continuations.
