# Sync Engine — Scenarios

Concrete implementation scenarios that validate the engine's interfaces. Each scenario names a source, destination, or orchestrator implementation with the interface it must satisfy and the tests that prove it.

## Sources

### source-stripe

The primary source. Reads from Stripe's core REST API.

**Backfill mode:** Paginate List APIs (`GET /v1/customers?starting_after=cus_xxx`) and emit `RecordMessage` per object. Emit `StateMessage` every N records with the pagination cursor. Finite — terminates when the last page is reached.

**Live mode:** Receive events via webhook (HTTP POST) or WebSocket and emit `RecordMessage` per event payload. Emit `StateMessage` after every event. Infinite — runs until stopped.

> The source includes an HTTP server (`server.ts`) that receives Stripe webhook POSTs and feeds them into the source's event stream. Multi-tenant merchant routing (e.g. dispatching webhooks to the correct sync by merchant ID) is a deployment concern layered on top — not a source-level concern.

**Backfill → live transition:** The source starts in backfill mode, notes the timestamp at start, then transitions to live mode once backfill completes. The live phase picks up from the noted timestamp with overlap. Duplicates are deduped at the destination via `primary_key`.

Interface tests:

| Test                                                                                              | Validates                  |
| ------------------------------------------------------------------------------------------------- | -------------------------- |
| `discover()` returns `CatalogMessage` with known Stripe streams (customer, invoice, charge, etc.) | Schema discovery           |
| `read()` in backfill mode emits `RecordMessage` + `StateMessage` in correct interleaving          | Message protocol           |
| `read()` with prior state resumes from the cursor, does not re-emit already-checkpointed records  | Resumability               |
| `read()` transitions from backfill → live without stopping                                        | Phase transition           |
| Live mode via webhook emits one `RecordMessage` + one `StateMessage` per event                    | Fine-grained checkpointing |
| Live mode via WebSocket emits the same messages as webhook mode                                   | Transport equivalence      |
| `read()` emits `ErrorMessage` with `failure_type: 'transient_error'` on rate limit                | Error protocol             |
| `read()` emits `ErrorMessage` with `failure_type: 'config_error'` on bad API key                  | Error protocol             |
| Source never imports from or references any destination module                                    | Architecture purity        |

## Destinations

### destination-postgres

Writes into a Postgres database. Creates tables from `CatalogMessage` schemas, upserts records, and confirms checkpoints.

Interface tests:

| Test                                                                                       | Validates               |
| ------------------------------------------------------------------------------------------ | ----------------------- |
| `write()` creates tables from `CatalogMessage` if they don't exist                         | Schema setup            |
| `write()` upserts `RecordMessage` data using `primary_key` for dedup                       | Record writing          |
| `write()` re-emits `StateMessage` after committing preceding records                       | Checkpoint confirmation |
| `write()` batches inserts for throughput (configurable batch size)                         | Flush behavior          |
| `write()` handles schema evolution (new columns discovered in subsequent `CatalogMessage`) | Schema migration        |
| `write()` emits `ErrorMessage` on connection failure                                       | Error protocol          |
| Destination never imports from or references any source module                             | Architecture purity     |

### destination-google-sheets

Writes into a Google Sheets spreadsheet. Creates sheets from `CatalogMessage` streams, appends rows, and confirms checkpoints.

Interface tests:

| Test                                                                  | Validates               |
| --------------------------------------------------------------------- | ----------------------- |
| `write()` creates a sheet per stream from `CatalogMessage`            | Schema setup            |
| `write()` appends rows from `RecordMessage` data                      | Record writing          |
| `write()` re-emits `StateMessage` after successful append             | Checkpoint confirmation |
| `write()` respects Google Sheets API rate limits (retry with backoff) | Rate limit handling     |
| `write()` emits `ErrorMessage` on auth failure                        | Error protocol          |
| Destination never imports from or references any source module        | Architecture purity     |

## Orchestrators

### orchestrator-postgres

Persists sync config and checkpoint state to a Postgres database. The state is stored on `Sync.state` — a per-stream checkpoint map keyed by `(sync_id, stream)`.

Interface tests:

| Test                                                                                | Validates              |
| ----------------------------------------------------------------------------------- | ---------------------- |
| Loads `Sync` config from Postgres on startup                                        | Config persistence     |
| Persists `Sync.state[stream]` on each confirmed `StateMessage` from the destination | Checkpoint persistence |
| Passes the full `Sync.state` map to `source.read()` on resume                       | State round-trip       |
| Filters messages: only `RecordMessage` and `StateMessage` reach the destination     | Message routing        |
| Routes `ErrorMessage` to error handling (not to destination)                        | Error routing          |
| Routes `LogMessage` to observability (not to destination)                           | Log routing            |
| Routes `StreamStatusMessage` to progress tracking (not to destination)              | Status routing         |

### orchestrator-fs

Persists sync config and checkpoint state to the local filesystem. Same interface as orchestrator-postgres but backed by JSON files on disk. Used for local development and the standalone CLI.

Interface tests:

| Test                                                                     | Validates              |
| ------------------------------------------------------------------------ | ---------------------- |
| Loads `Sync` config from a JSON file on startup                          | Config persistence     |
| Persists `Sync.state[stream]` to a file on each confirmed `StateMessage` | Checkpoint persistence |
| Passes the full `Sync.state` map to `source.read()` on resume            | State round-trip       |
| Same message routing behavior as orchestrator-postgres                   | Interface equivalence  |

## Cross-cutting Scenarios

### orchestrator-postgres + destination-postgres (same database)

The orchestrator and destination write to the **same** Postgres instance. The orchestrator stores sync config and state. The destination stores synced data (tables created from `CatalogMessage`).

This scenario validates:

| Test                                                                               | Validates             |
| ---------------------------------------------------------------------------------- | --------------------- |
| Orchestrator and destination use separate schemas (e.g. `sync_engine` vs `stripe`) | Schema isolation      |
| Orchestrator state writes and destination data writes are independent transactions | Transaction isolation |
| A destination write failure does not corrupt orchestrator state                    | Failure isolation     |
| An orchestrator state write failure does not corrupt destination data              | Failure isolation     |
| Both can operate within a single Postgres connection pool                          | Resource sharing      |
| Schema migrations for orchestrator tables don't affect destination tables          | Migration isolation   |

### Supabase dashboard installation

A Supabase user installs the Stripe sync integration from their dashboard. This is an end-to-end deployment scenario, not a unit test.

Flow:

1. User clicks "Install Stripe Sync" in Supabase dashboard
2. System provisions a Sync with `source: stripe-api-core` and `destination: postgres` targeting the user's Supabase Postgres
3. User provides their Stripe API key (stored as a Credential)
4. Orchestrator uses orchestrator-postgres backed by the same Supabase Postgres
5. Sync begins backfill → transitions to live
6. User queries their Supabase Postgres and sees Stripe data in the `stripe` schema

Validates:

| Aspect                     | What to check                                                     |
| -------------------------- | ----------------------------------------------------------------- |
| Single-database deployment | orchestrator-postgres + destination-postgres on the same instance |
| Credential flow            | API key → Credential → source config                              |
| Zero-config destination    | Destination auto-creates tables from `CatalogMessage`             |
| Backfill → live            | Source transitions without user intervention                      |
| Schema in Supabase         | Tables appear in Supabase's table viewer / SQL editor             |
| Dashboard status           | Sync status (backfilling → syncing) is visible to the user        |

## Files

| File                   | Description                                             |
| ---------------------- | ------------------------------------------------------- |
| `scenarios.md`         | This document                                           |
| `ARCHITECTURE.md`      | Protocol spec, message types, orchestrator, state flow  |
| `sync-engine-types.ts` | Message protocol type definitions                       |
| `sync-engine-api.ts`   | Source, Destination, Transform, Orchestrator interfaces |
