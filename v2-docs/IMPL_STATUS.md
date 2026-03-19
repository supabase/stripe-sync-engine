# Implementation Status

Single source of truth for what's done, what's in progress, and what's left. The prose program reads this file to determine completion.

**Last updated**: 2026-03-18
**Branch**: `refactor/v2-architecture`

## Packages

Target structure from `packages.md`. Status: EXISTS / MISSING / WRONG.

| Package                              | Status  | Notes                                                                                                    |
| ------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------- |
| `packages/sync-protocol`             | EXISTS  | Zero deps. 6 source files. Clean.                                                                        |
| `packages/source-stripe`             | EXISTS  | Missing: `backfill.ts`, `live.ts`, `server.ts`, `streams/`. Has: monolithic `stripeSource.ts` instead.   |
| `packages/destination-postgres`      | EXISTS  | Has real `write()`. Missing: `schema.ts`, `migrations.ts` as separate files.                             |
| `packages/destination-google-sheets` | EXISTS  | Fully implemented. `write()` works. E2E test.                                                            |
| `packages/orchestrator-postgres`     | EXISTS  | `forward()`, `collect()`, `run()` all implemented. Missing: `config.ts` (Sync persistence).              |
| `packages/orchestrator-fs`           | MISSING | Not created yet.                                                                                         |
| `packages/sync-service`              | MISSING | Not created yet. Composition root role currently in `packages/sync-engine`.                              |
| `packages/db-service`                | MISSING | Not created yet.                                                                                         |
| `packages/fastify-app`               | WRONG   | Should not exist. Webhook server belongs in `source-stripe/src/server.ts`. Must be absorbed and deleted. |
| `apps/supabase/dashboard`            | EXISTS  | Moved from `packages/dashboard`. Clean.                                                                  |
| `apps/supabase/edge-functions`       | WRONG   | Still lives inside `packages/sync-engine/src/supabase/`. Should be `apps/supabase/edge-functions/`.      |

## Code that must move OUT of `sync-engine`

These files still live in `packages/sync-engine/src/` but belong in sub-packages per the architecture.

| File                     | Lines | Target package                                                                                   | Blocker                                |
| ------------------------ | ----- | ------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `stripeSyncWorker.ts`    | 303   | `source-stripe` (becomes backfill.ts)                                                            | Coupled to WorkerTaskManager callbacks |
| `stripeSyncWebhook.ts`   | 405   | `source-stripe` (becomes live.ts)                                                                | Coupled to DestinationWriter callbacks |
| `resourceRegistry.ts`    | 382   | `source-stripe` (streams/)                                                                       | 8+ inbound importers in sync-engine    |
| `websocket-client.ts`    | ~100  | `source-stripe` (live.ts)                                                                        | Used by webhook path                   |
| `catalogFromRegistry.ts` | ~50   | `source-stripe` (already has copy as catalog.ts)                                                 | Test file imports it                   |
| `stripeSync.ts`          | 804   | Split: orchestration → `orchestrator-postgres`, composition → `sync-service`                     | Monolith — needs decomposition         |
| `database/postgres.ts`   | 1557  | Split: writes → `destination-postgres`, state → `orchestrator-postgres`, accounts → `db-service` | Monolith — needs decomposition         |
| `supabase/`              | ~300  | `apps/supabase/edge-functions/`                                                                  | `?raw` bundler imports, Deno runtime   |

## Interface implementations

Per `scenarios.md` test tables. Status: REAL / STUB / MISSING.

### source-stripe

| Method                                  | Status  | Test coverage                                                       |
| --------------------------------------- | ------- | ------------------------------------------------------------------- |
| `discover()`                            | REAL    | 3 tests (catalog, filtering, empty)                                 |
| `read()` backfill mode                  | REAL    | 8 tests (pagination, resume, errors)                                |
| `read()` live mode (infinite generator) | MISSING | Only `fromWebhookEvent()` static helper exists. No async generator. |
| `read()` backfill→live transition       | MISSING | No implementation. .todo test stub.                                 |
| `fromWebhookEvent()`                    | REAL    | 7 tests                                                             |
| `server.ts` (webhook HTTP server)       | MISSING | Lives in `fastify-app`, not absorbed yet.                           |
| `cli.ts` (source read, source discover) | STUB    | Throws "not yet implemented"                                        |

### destination-postgres

| Method                         | Status  | Test coverage                  |
| ------------------------------ | ------- | ------------------------------ |
| `write()` — schema setup       | REAL    | 3 tests                        |
| `write()` — batched upsert     | REAL    | 3 tests                        |
| `write()` — checkpoint re-emit | REAL    | 1 test                         |
| `write()` — schema evolution   | MISSING | No ALTER TABLE for new columns |
| `write()` — error protocol     | REAL    | 2 tests                        |
| `cli.ts` (dest write)          | STUB    | Throws "not yet implemented"   |

### destination-google-sheets

| Method                          | Status | Test coverage                  |
| ------------------------------- | ------ | ------------------------------ |
| `write()` — full implementation | REAL   | 1 E2E test (needs credentials) |
| Rate limit retry                | REAL   | Built into writer.ts           |

### orchestrator-postgres

| Method                                 | Status  | Test coverage                |
| -------------------------------------- | ------- | ---------------------------- |
| `forward()`                            | REAL    | 10 tests                     |
| `collect()`                            | REAL    | 4 tests                      |
| `run()`                                | REAL    | 10 tests (mock source/dest)  |
| `stop()`                               | REAL    | 1 test (abort controller)    |
| StreamStatusMessage routing            | REAL    | 1 test                       |
| Sync config persistence (load from DB) | MISSING | .todo test stub              |
| `cli.ts` (orch run)                    | STUB    | Throws "not yet implemented" |

### orchestrator-fs

| Method     | Status  | Test coverage         |
| ---------- | ------- | --------------------- |
| Everything | MISSING | Package doesn't exist |

### sync-engine (composition root)

| Feature                          | Status | Test coverage |
| -------------------------------- | ------ | ------------- |
| `runPipeline()`                  | REAL   | 6 tests       |
| Re-exports from all sub-packages | REAL   | —             |

## Scenario test coverage

From `v2/docs/2-sync-engine/scenarios.md`. PASS = real test, TODO = .todo stub, NONE = no test at all.

### source-stripe scenarios

| Scenario                                                        | Status                      |
| --------------------------------------------------------------- | --------------------------- |
| discover() returns CatalogMessage with known streams            | PASS                        |
| read() backfill emits RecordMessage + StateMessage interleaving | PASS                        |
| read() with prior state resumes from cursor                     | PASS                        |
| read() transitions backfill → live                              | TODO                        |
| Live webhook emits RecordMessage + StateMessage per event       | PASS (via fromWebhookEvent) |
| Live WebSocket same as webhook                                  | PASS (via fromWebhookEvent) |
| read() ErrorMessage transient_error on rate limit               | PASS                        |
| read() ErrorMessage config_error on bad API key                 | PASS                        |
| Source never imports destination                                | PASS                        |

### destination-postgres scenarios

| Scenario                                   | Status |
| ------------------------------------------ | ------ |
| write() creates tables from CatalogMessage | PASS   |
| write() upserts with primary_key dedup     | PASS   |
| write() re-emits StateMessage after commit | PASS   |
| write() batches inserts (configurable)     | PASS   |
| write() schema evolution (new columns)     | NONE   |
| write() ErrorMessage on connection failure | PASS   |
| Destination never imports source           | PASS   |

### orchestrator-postgres scenarios

| Scenario                                      | Status |
| --------------------------------------------- | ------ |
| Loads Sync config from Postgres               | TODO   |
| Persists Sync.state per stream                | PASS   |
| Passes full state map on resume               | PASS   |
| Filters: only data messages reach destination | PASS   |
| Routes ErrorMessage to error handling         | PASS   |
| Routes LogMessage to observability            | PASS   |
| Routes StreamStatusMessage to progress        | PASS   |

### orchestrator-fs scenarios

| Scenario | Status                 |
| -------- | ---------------------- |
| All      | NONE (package missing) |

### Cross-cutting scenarios

| Scenario                             | Status |
| ------------------------------------ | ------ |
| Same-DB: orch + dest on one Postgres | NONE   |
| Supabase dashboard installation      | NONE   |

## Remaining work (ordered by priority)

### P0 — Must do (architecture violations)

1. **Delete `packages/fastify-app`**. Absorb webhook server into `source-stripe/src/server.ts`. Refactor imports to use `StripeSource.fromWebhookEvent()` instead of `StripeSync.webhook.processWebhook()`. Move tests that are pure webhook-parsing tests; delete tests that are sync-engine integration tests wearing a fastify-app costume.

2. **Move `resourceRegistry.ts` to `source-stripe`**. This is Stripe stream metadata — it belongs in the source. Requires updating 8+ importers in sync-engine to use `@stripe/source-stripe`.

3. **Move `stripeSyncWorker.ts` to `source-stripe`** as `backfill.ts`. Adapt from callback-based to generator-based (yield RecordMessage instead of calling onRecordMessages callback).

4. **Move `stripeSyncWebhook.ts` to `source-stripe`** as `live.ts`. Implement the infinite `read()` generator with an async event queue that the webhook server pushes into.

### P1 — Should do (completeness)

5. **Implement `orchestrator-fs`** package. Same interface as orchestrator-postgres but backed by JSON files. For local dev and standalone CLI.

6. **Implement real CLI entrypoints**. Each package's `cli.ts` should parse argv and invoke the right code path. `source read`, `dest write`, `orch run`.

7. **Implement schema evolution** in destination-postgres. ALTER TABLE for new columns discovered in subsequent CatalogMessage.

8. **Fill remaining .todo test stubs**: Sync config from Postgres, backfill→live transition.

9. **Implement `read()` live mode** as async generator with event queue. The `fromWebhookEvent()` static helper is the building block; the generator wraps it with push-based event ingestion.

### P2 — Future (new packages)

10. **Create `packages/sync-service`**. Sync CRUD API. Currently the composition root role is in `packages/sync-engine` — that's fine for now but should eventually become a proper service package.

11. **Create `packages/db-service`**. DB lifecycle API with sync enrichment.

12. **Move `apps/supabase/edge-functions`** out of `sync-engine/src/supabase/`. Requires solving `?raw` bundler imports.

13. **Decompose `stripeSync.ts`** (804 lines) and `database/postgres.ts` (1557 lines). These monoliths should be split across packages once all consumers are migrated.

## Completion criteria

The prose program should NOT declare COMPLETE until:

- [ ] `packages/fastify-app` does not exist
- [ ] `packages/source-stripe` has `server.ts` (webhook HTTP server)
- [ ] `packages/source-stripe` has `backfill.ts` and `live.ts` (not monolithic stripeSource.ts)
- [ ] `packages/orchestrator-fs` exists with passing tests
- [ ] All CLI stubs replaced with real argv parsing
- [ ] All .todo test stubs filled or removed with justification
- [ ] All scenarios.md tests at PASS or explicitly descoped with reason
- [ ] `pnpm build && pnpm test && pnpm lint` clean
- [ ] Zero cross-boundary imports between source/destination packages
