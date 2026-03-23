# Plan: Rewrite Supabase backfill to fan-out via edge function invocations

## Context

The current `stripe-worker.ts` is dead code — it imports `StripeSyncWorker` and `WorkerTaskManager` from `@stripe/source-stripe`, but both were deleted in the v2 protocol refactor. The old design ran N workers in-memory within a single edge function invocation, all claiming tasks from a shared Postgres queue.

The new design fans out at the **stream level**: a coordinator discovers streams and dispatches one HTTP call per stream to a backfill worker. Each worker paginates its stream with bounded page counts, saves cursor state to Postgres, and self-reinvokes if there are more pages. When the last worker finishes, a barrier query atomically detects completion.

Architecture is documented in `v2-docs/plan-006-supabase-fan-out-backfill.md`.

## Files

| File                                                         | Action                                |
| ------------------------------------------------------------ | ------------------------------------- |
| `apps/supabase/src/edge-functions/stripe-worker.ts`          | Rewrite → coordinator                 |
| `apps/supabase/src/edge-functions/stripe-backfill-worker.ts` | Create → per-stream worker            |
| `apps/supabase/src/edge-function-code.ts`                    | Add backfill worker raw import        |
| `apps/supabase/src/supabase.ts`                              | Deploy + uninstall backfill worker fn |

## 1. Coordinator (`stripe-worker.ts` rewrite)

Keep: vault-based Bearer auth, `SYNC_INTERVAL` skip logic, module-level `pool`/`stripe`/`registry`.

Replace everything after auth with:

1. Check if a recent completed run exists in `_sync_runs` → skip if within interval
2. `CREATE TABLE IF NOT EXISTS` for `_sync_state` and `_sync_runs` (idempotent)
3. Build catalog via `catalogFromRegistry(registry)` → get stream names
4. Generate `sync_id` = `sync_${Date.now()}`
5. Insert `_sync_runs` row + one `_sync_state` row per stream (`ON CONFLICT DO NOTHING`)
6. Fan out: `Promise.all(streams.map(s => fetch(SELF_URL + '/stripe-backfill-worker', { body: { sync_id, stream } })))` (fire-and-forget)
7. Return `{ sync_id, streams: N, status: 'started' }`

**Reuse from current code:** auth pattern (vault secret check), `pool`, `stripe`, `registry` module-level singletons, `schemaName` env var.

## 2. Backfill worker (`stripe-backfill-worker.ts` — new)

```
Deno.serve(async (req) => {
  // Auth: vault worker secret (same as coordinator)
  // Parse: { sync_id, stream } from body
  // Load cursor from _sync_state
  // Mark status = 'syncing'
  // Paginate PAGES_PER_INVOCATION pages:
  //   listFn({ limit: 100, starting_after: cursor })
  //   upsertMany(response.data, stream) via PostgresDestinationWriter
  //   track newRecords count
  // Save cursor + records to _sync_state
  // If has_more: self-reinvoke POST /stripe-backfill-worker
  // Else: mark complete, checkCompletion(sync_id)
})
```

Key details:

- `PAGES_PER_INVOCATION = 10` (configurable via env, ~1-2s work, well within 50s)
- Get `listFn` via `findConfigByTableName(registry, stream)` — same helper used in `backfill.ts:517`
- Write via `PostgresDestinationWriter.upsertMany()` — same as old worker
- Self-reinvocation: fire-and-forget `fetch()` with same auth header
- `checkCompletion()`: atomic `UPDATE _sync_runs ... WHERE NOT EXISTS (incomplete streams)`
- Error handling: catch → mark stream `error` in `_sync_state` → still `checkCompletion()`

**Why not `source.read()`?** The async generator paginates all pages and also runs events polling / live mode. Breaking out after N pages requires a bounded-read wrapper, and generator cleanup across HTTP boundaries is fragile. Calling `listFn()` directly is simpler and matches plan-006.

## 3. State tables (inline DDL)

```sql
CREATE TABLE IF NOT EXISTS {schema}._sync_state (
  sync_id    text NOT NULL,
  stream     text NOT NULL,
  cursor     text,
  status     text NOT NULL DEFAULT 'pending',  -- pending|syncing|complete|error
  records    int  NOT NULL DEFAULT 0,
  error      text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sync_id, stream)
);

CREATE TABLE IF NOT EXISTS {schema}._sync_runs (
  sync_id      text PRIMARY KEY,
  status       text NOT NULL DEFAULT 'syncing',  -- syncing|complete|error
  total_streams int NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
```

Created by coordinator on each run (`CREATE TABLE IF NOT EXISTS` = idempotent, no migration needed).

## 4. Edge function code + deployment

`edge-function-code.ts` — add:

```ts
import backfillWorkerCodeRaw from './edge-functions/stripe-backfill-worker.ts?raw'
export const backfillWorkerFunctionCode = backfillWorkerCodeRaw as string
```

`supabase.ts` — in `install()`:

```ts
await this.deployFunction('stripe-backfill-worker', versionedBackfillWorker, false)
```

In `uninstall()` (inside `stripe-setup.ts` DELETE handler), add cleanup for the new function slug.

## Reusable code

| What                                     | Where                                                                   | Used by                        |
| ---------------------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| `buildResourceRegistry(stripe)`          | `source-stripe/src/resourceRegistry.ts`                                 | Both coordinator + worker      |
| `catalogFromRegistry(registry)`          | `source-stripe/src/catalog.ts`                                          | Coordinator (stream list)      |
| `findConfigByTableName` pattern          | `source-stripe/src/backfill.ts:95` (private — inline 1-liner in worker) | Worker (resolve listFn)        |
| `PostgresDestinationWriter.upsertMany()` | `destination-postgres/src/writer.ts`                                    | Worker (write records)         |
| Vault auth pattern                       | current `stripe-worker.ts:52-70`                                        | Both coordinator + worker      |
| `fromRecordMessage()`                    | `sync-protocol`                                                         | Worker (convert before upsert) |

## Verification

```sh
pnpm build
pnpm format
pnpm lint
pnpm --filter @stripe/integration-supabase test
```

Manual: read coordinator and worker code, trace the fan-out → self-reinvoke → barrier flow.
