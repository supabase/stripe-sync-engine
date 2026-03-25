# Implementation Status

Single source of truth for what's done, what's in progress, and what's left.

**Last updated**: 2026-03-23
**Branch**: `v2`

## Packages

Target structure from `packages.md`. Status: EXISTS / MISSING / WRONG.

| Package                              | Status | Notes                                                                                           |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------------------- |
| `packages/protocol`                  | EXISTS | Zero deps. Defines Source, Destination interfaces. Message types + Zod schemas.                 |
| `packages/source-stripe`             | EXISTS | Has `backfill.ts`, `streams/`, `openapi/`, `cli.ts`. Three input modes: stdin, WebSocket, HTTP. |
| `packages/destination-postgres`      | EXISTS | Has real `write()`. No Stripe-specific knowledge (openapi moved out).                           |
| `packages/destination-google-sheets` | EXISTS | Fully implemented. `write()` works. E2E test.                                                   |
| `packages/stateless-sync`            | EXISTS | Engine (`createEngine`), connector loader, pipeline utils (`forward`, `collect`).               |
| `packages/stateful-sync`             | EXISTS | `StatefulSync` class, store interfaces + implementations.                                       |
| `packages/store-postgres`            | EXISTS | Migration runner + embedded migrations.                                                         |
| `packages/util-postgres`             | EXISTS | Shared Postgres helpers (upsert, rate limiter).                                                 |
| `packages/ts-cli`                    | EXISTS | Generic TypeScript module CLI runner.                                                           |
| `apps/stateless`                     | EXISTS | One-shot CLI + HTTP API.                                                                        |
| `apps/stateful`                      | EXISTS | Persistent CLI + HTTP API with file-based stores.                                               |
| `apps/sync-engine`                   | EXISTS | Published CLI (`sync-engine` binary).                                                           |
| `apps/supabase`                      | EXISTS | Supabase integration (edge functions).                                                          |

## Architecture compliance

### Isolation: source never imports destination

`source-stripe` library code (`src/index.ts` entrypoint) has zero imports from `@stripe/sync-destination-postgres`.

- Fastify server, `WebhookWriter`, `StripeSyncWebhook` all deleted — webhook HTTP listener now lives inside `read()` using Node `http.createServer`
- No `optionalDependencies` on `@stripe/sync-destination-postgres`

### Isolation: destination has no Stripe-specific knowledge

The source/destination boundary follows the protocol: `source.discover()` produces a catalog with `json_schema` (derived from the Stripe OpenAPI spec via `SpecParser` + `parsedTableToJsonSchema`), and `destination-postgres` reads `json_schema` to produce Postgres DDL via `schemaProjection.ts` (`buildCreateTableWithSchema`, `applySchemaFromCatalog`).

Callers (`apps/sync-engine`) call `runMigrations()` for bootstrap, then `source.discover()` + `applySchemaFromCatalog()` for Stripe-specific schema.

### Protocol interfaces

`packages/protocol` defines both core interfaces:

- `Source` — `spec()`, `check()`, `discover()`, `read(params, $stdin?)`; optional `setup?()`, `teardown?()`
- `Destination` — `spec()`, `check()`, `write(params, $stdin)`; optional `setup?()`, `teardown?()`

There is no `Orchestrator` interface — orchestration is handled by `createEngine()` in `@stripe/sync-lib-stateless`.

## Interface implementations

### source-stripe

| Method                                   | Status  | Test coverage                                                                       |
| ---------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `discover()`                             | REAL    | 3 tests (catalog, filtering, empty)                                                 |
| `read()` backfill mode                   | REAL    | 8 tests (pagination, resume, errors)                                                |
| `read(params, $stdin)` webhook/live mode | REAL    | 15 tests — full pipeline: sig verify, delete, revalidation, entitlements, sub items |
| `read()` HTTP server mode                | REAL    | Built-in `http.createServer` on `webhook_port`, backpressure via async generator    |
| `read()` backfill→live transition        | MISSING | .todo test stub                                                                     |
| `fromWebhookEvent()`                     | REAL    | 7 tests (simpler path, still used by WebSocket drain queue)                         |
| `cli.ts` (source discover, source read)  | REAL    | Working argv-based entrypoint.                                                      |
| `openapi/` (Stripe schema→DDL)           | REAL    | Moved from destination-postgres. 4 test suites.                                     |

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

### stateless-sync (engine)

| Method / Function           | Status | Test coverage               |
| --------------------------- | ------ | --------------------------- |
| `createEngine()`            | REAL   | 10 tests (mock source/dest) |
| `forward()`                 | REAL   | 10 tests                    |
| `collect()`                 | REAL   | 4 tests                     |
| StreamStatusMessage routing | REAL   | 1 test                      |
| `spawnSource()`             | REAL   | Subprocess adapter          |
| `spawnDestination()`        | REAL   | Subprocess adapter          |

### stateful-sync (StatefulSync)

| Method                              | Status | Test coverage     |
| ----------------------------------- | ------ | ----------------- |
| `StatefulSync.run()`                | REAL   | Integration tests |
| State persistence (load from store) | REAL   | Integration tests |
| Credential refresh on auth_error    | REAL   | Unit test         |

## Scenario test coverage

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

### engine scenarios

| Scenario                                      | Status |
| --------------------------------------------- | ------ |
| Persists state per stream                     | PASS   |
| Passes full state map on resume               | PASS   |
| Filters: only data messages reach destination | PASS   |
| Routes ErrorMessage to error handling         | PASS   |
| Routes LogMessage to observability            | PASS   |
| Routes StreamStatusMessage to progress        | PASS   |

### cross-cutting scenarios

| Scenario                               | Status |
| -------------------------------------- | ------ |
| Same-DB: engine + dest on one Postgres | NONE   |
| Supabase dashboard installation        | NONE   |

## Remaining work (ordered by priority)

### P0 — Architecture violations

All P0 items resolved:

- ~~source-stripe imports from destination-postgres~~ → Fixed: Fastify server, WebhookWriter, StripeSyncWebhook deleted
- ~~openapi/ in destination-postgres~~ → Moved to source-stripe
- ~~Monolithic stripeSource.ts~~ → Split into backfill.ts, streams/
- ~~No engine in protocol~~ → Engine in stateless-sync (`createEngine`)

### P1 — Should do (completeness)

1. **Implement schema evolution** in destination-postgres. ALTER TABLE for new columns discovered in subsequent CatalogMessage.

2. **Fill remaining .todo test stubs**: backfill→live transition.

3. **Add dedicated tests for `liveReader`** in source-stripe. The async generator exists but has no standalone test suite.

### Known limitations

- **Entitlement reconciliation gap**: `read(params, $stdin)` for `entitlements.active_entitlement_summary.updated` yields the current active entitlement set but cannot delete stale entitlements — the source doesn't know what's in the destination. Stale entitlements accumulate until the next full refresh. Fix requires a new `StreamResetMessage` (or similar) that tells the destination to clear-and-replace a subset (e.g., `WHERE customer = :id`).

## Completion criteria

- [x] `packages/fastify-app` does not exist
- [x] `packages/source-stripe` has `backfill.ts` and `live.ts` (not monolithic stripeSource.ts)
- [x] `packages/source-stripe` has `streams/` (not schemas/)
- [x] `packages/source-stripe` webhook HTTP listener lives inside `read()` (no separate server/)
- [x] `packages/source-stripe` has `openapi/` (Stripe schema→DDL)
- [x] `packages/stateless-sync` exists with engine + connector loader
- [x] `packages/stateful-sync` exists with `StatefulSync` class
- [x] All CLI stubs replaced with real implementations
- [x] `Source` and `Destination` interfaces defined in `packages/protocol`
- [x] `createEngine()` in `@stripe/sync-lib-stateless`
- [x] Zero cross-boundary imports between source/destination library code
- [x] `pnpm build && pnpm lint` clean
- [ ] All .todo test stubs filled or removed with justification
- [ ] All scenarios.md tests at PASS or explicitly descoped with reason
- [ ] Schema evolution in destination-postgres
