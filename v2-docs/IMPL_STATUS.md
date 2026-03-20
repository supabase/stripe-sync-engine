# Implementation Status

Single source of truth for what's done, what's in progress, and what's left. The prose program reads this file to determine completion.

**Last updated**: 2026-03-18
**Branch**: `v2`

## Packages

Target structure from `packages.md`. Status: EXISTS / MISSING / WRONG.

| Package                              | Status  | Notes                                                                                                |
| ------------------------------------ | ------- | ---------------------------------------------------------------------------------------------------- |
| `packages/sync-protocol`             | EXISTS  | Zero deps. Defines Source, Destination, Orchestrator interfaces. Has `forward()`/`collect()` router. |
| `packages/source-stripe`             | EXISTS  | Has `backfill.ts`, `streams/`, `openapi/`, `cli.ts`. Three input modes: stdin, WebSocket, HTTP.      |
| `packages/destination-postgres`      | EXISTS  | Has real `write()`. No Stripe-specific knowledge (openapi moved out).                                |
| `packages/destination-google-sheets` | EXISTS  | Fully implemented. `write()` works. E2E test.                                                        |
| `packages/orchestrator-postgres`     | EXISTS  | `forward()`, `collect()`, `run()` all implemented. Implements `Orchestrator<Sync>` from protocol.    |
| `packages/orchestrator-fs`           | EXISTS  | Filesystem-backed orchestrator. 10 tests passing.                                                    |
| `packages/sync-service`              | MISSING | Not created yet. Composition root role currently in `apps/cli`.                                      |
| `apps/cli`                           | EXISTS  | CLI application. Composes source-stripe + destination-postgres.                                      |
| `apps/supabase`                      | EXISTS  | Supabase integration (edge functions).                                                               |
| `apps/supabase-dashboard`            | EXISTS  | Moved from `packages/dashboard`. Clean.                                                              |

## Architecture compliance

### Isolation: source never imports destination

`source-stripe` library code (`src/index.ts` entrypoint) has zero imports from `@stripe/destination-postgres`.

- Fastify server, `WebhookWriter`, `StripeSyncWebhook` all deleted — webhook HTTP listener now lives inside `read()` using Node `http.createServer`
- No `optionalDependencies` on `@stripe/destination-postgres`

### Isolation: destination has no Stripe-specific knowledge

The source/destination boundary follows the protocol: `source.discover()` produces a catalog with `json_schema` (derived from the Stripe OpenAPI spec via `SpecParser` + `parsedTableToJsonSchema`), and `destination-postgres` reads `json_schema` to produce Postgres DDL via `schemaProjection.ts` (`buildCreateTableWithSchema`, `applySchemaFromCatalog`).

Callers (`apps/cli`) call `runMigrations()` for bootstrap, then `source.discover()` + `applySchemaFromCatalog()` for Stripe-specific schema.

### Protocol interfaces

`sync-protocol` defines all three core interfaces:

- `Source` — `spec()`, `check()`, `discover()`, `read()`
- `Destination` — `spec()`, `check()`, `write()`
- `Orchestrator<TSync>` — `forward()`, `collect()`, `run()`, `stop()`

Shared message routing (`forward()`, `collect()`, `RouterCallbacks`) is in `sync-protocol/src/router.ts`.

## Interface implementations

### source-stripe

| Method                                  | Status  | Test coverage                                                                       |
| --------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `discover()`                            | REAL    | 3 tests (catalog, filtering, empty)                                                 |
| `read()` backfill mode                  | REAL    | 8 tests (pagination, resume, errors)                                                |
| `read(input)` webhook/live mode         | REAL    | 15 tests — full pipeline: sig verify, delete, revalidation, entitlements, sub items |
| `read()` HTTP server mode               | REAL    | Built-in `http.createServer` on `webhook_port`, backpressure via async generator    |
| `read()` backfill→live transition       | MISSING | .todo test stub                                                                     |
| `fromWebhookEvent()`                    | REAL    | 7 tests (simpler path, still used by WebSocket drain queue)                         |
| `cli.ts` (source discover, source read) | REAL    | Working argv-based entrypoint.                                                      |
| `openapi/` (Stripe schema→DDL)          | REAL    | Moved from destination-postgres. 4 test suites.                                     |

### destination-postgres

| Method                         | Status  | Test coverage                                |
| ------------------------------ | ------- | -------------------------------------------- |
| `write()` — schema setup       | REAL    | 3 tests                                      |
| `write()` — batched upsert     | REAL    | 3 tests                                      |
| `write()` — checkpoint re-emit | REAL    | 1 test                                       |
| `write()` — schema evolution   | MISSING | No ALTER TABLE for new columns               |
| `write()` — error protocol     | REAL    | 2 tests                                      |
| `cli.ts` (dest write)          | REAL    | Reads NDJSON from stdin, writes to Postgres. |

### destination-google-sheets

| Method                          | Status | Test coverage                  |
| ------------------------------- | ------ | ------------------------------ |
| `write()` — full implementation | REAL   | 1 E2E test (needs credentials) |
| Rate limit retry                | REAL   | Built into writer.ts           |

### orchestrator-postgres

| Method                                 | Status  | Test coverage                                  |
| -------------------------------------- | ------- | ---------------------------------------------- |
| `forward()`                            | REAL    | 10 tests                                       |
| `collect()`                            | REAL    | 4 tests                                        |
| `run()`                                | REAL    | 10 tests (mock source/dest)                    |
| `stop()`                               | REAL    | 1 test (abort controller)                      |
| StreamStatusMessage routing            | REAL    | 1 test                                         |
| Implements `Orchestrator<Sync>`        | REAL    | Type-checked via interface                     |
| Sync config persistence (load from DB) | MISSING | .todo test stub                                |
| `cli.ts` (orch run)                    | REAL    | Accepts Source + Destination programmatically. |

### orchestrator-fs

| Method                                  | Status | Test coverage                                   |
| --------------------------------------- | ------ | ----------------------------------------------- |
| `FsOrchestrator.forward()`              | REAL   | 2 tests (filtering, callback routing)           |
| `FsOrchestrator.collect()`              | REAL   | 2 tests (state yield, callback routing)         |
| `FsOrchestrator.run()`                  | REAL   | Implemented, uses shared router from protocol   |
| `FsStateStore`                          | REAL   | 5 tests (round-trip, overwrite, clear, isolate) |
| `loadSyncConfig/saveSyncConfig`         | REAL   | JSON file read/write                            |
| Implements `Orchestrator<FsSyncConfig>` | REAL   | Type-checked via interface                      |

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

| Scenario                                        | Status |
| ----------------------------------------------- | ------ |
| State round-trips through save and load         | PASS   |
| Empty state for unknown sync                    | PASS   |
| Overwrites existing stream state                | PASS   |
| Clears all state for a sync                     | PASS   |
| Isolates state between different syncs          | PASS   |
| forward() passes records+state, drops others    | PASS   |
| forward() routes log messages to onLog callback | PASS   |
| collect() yields StateMessage                   | PASS   |
| collect() routes log and error to callbacks     | PASS   |

### Cross-cutting scenarios

| Scenario                             | Status |
| ------------------------------------ | ------ |
| Same-DB: orch + dest on one Postgres | NONE   |
| Supabase dashboard installation      | NONE   |

## Remaining work (ordered by priority)

### P0 — Architecture violations

All P0 items resolved:

- ~~source-stripe imports from destination-postgres~~ → Fixed: Fastify server, WebhookWriter, StripeSyncWebhook deleted
- ~~openapi/ in destination-postgres~~ → Moved to source-stripe
- ~~Monolithic stripeSource.ts~~ → Split into backfill.ts, streams/
- ~~No Orchestrator interface in sync-protocol~~ → Added alongside Source and Destination

### P1 — Should do (completeness)

1. **Implement schema evolution** in destination-postgres. ALTER TABLE for new columns discovered in subsequent CatalogMessage.

2. **Fill remaining .todo test stubs**: Sync config from Postgres, backfill→live transition.

3. **Add dedicated tests for `liveReader`** in source-stripe. The async generator exists but has no standalone test suite.

### Known limitations

- **Entitlement reconciliation gap**: `read(input)` for `entitlements.active_entitlement_summary.updated` yields the current active entitlement set but cannot delete stale entitlements — the source doesn't know what's in the destination. Stale entitlements accumulate until the next full refresh. Fix requires a new `StreamResetMessage` (or similar) that tells the destination to clear-and-replace a subset (e.g., `WHERE customer = :id`).

### P2 — Future (new packages)

4. **Create `packages/sync-service`**. Sync CRUD API. Currently the composition root role is in `apps/cli`.

5. ~~Decompose remaining monoliths~~ — Fastify server deleted, webhook listener lives inside `read()`.

## Completion criteria

- [x] `packages/fastify-app` does not exist
- [x] `packages/sync-engine` does not exist (monolith deleted)
- [x] `packages/source-stripe` has `backfill.ts` and `live.ts` (not monolithic stripeSource.ts)
- [x] `packages/source-stripe` has `streams/` (not schemas/)
- [x] `packages/source-stripe` webhook HTTP listener lives inside `read()` (no separate server/)
- [x] `packages/source-stripe` has `openapi/` (Stripe schema→DDL)
- [x] `packages/orchestrator-fs` exists with passing tests
- [x] All CLI stubs replaced with real implementations
- [x] `Orchestrator` interface defined in `sync-protocol` alongside Source and Destination
- [x] Shared `forward()`/`collect()` router in `sync-protocol`
- [x] Zero cross-boundary imports between source/destination library code
- [x] `pnpm build && pnpm lint` clean
- [ ] All .todo test stubs filled or removed with justification
- [ ] All scenarios.md tests at PASS or explicitly descoped with reason
- [ ] Schema evolution in destination-postgres
