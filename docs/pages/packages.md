# Monorepo Packages

The sync engine decomposes into packages along the architecture's isolation boundaries. The rule is simple: **sources and destinations never depend on each other.** They only depend on the core protocol.

```
packages/
├── protocol/                 ← core protocol (message types, interfaces, Zod schemas)
├── stateless-sync/           ← engine, connector loader, pipeline utilities
├── stateful-sync/            ← store interfaces + StatefulSync coordinator
├── source-stripe/            ← Stripe API source connector
├── destination-postgres/     ← Postgres destination connector
├── destination-google-sheets/← Google Sheets destination connector
├── store-postgres/           ← Postgres migration runner + embedded migrations
├── util-postgres/            ← shared Postgres utilities (upsert, rate limiter)
└── ts-cli/                   ← generic TypeScript module CLI runner
apps/
├── stateless/                ← one-shot CLI + HTTP API (no persistence between runs)
├── stateful/                 ← persistent CLI + HTTP API (credentials, config, state on disk)
├── sync-engine/              ← published CLI (npm: @stripe/sync-engine, binary: sync-engine)
└── supabase/                 ← Supabase integration (edge functions + deployment)
```

## Dependency graph

```
  ┌────────────────┐       ┌──────────────┐  ┌──────────────┐
  │   protocol     │       │store-postgres │  │ util-postgres │
  │  (types only)  │       │  (pg only)    │  │  (pg only)    │
  └───────┬────────┘       └──────────────┘  └──────────────┘
          │                  standalone — no protocol dep
    ┌─────┼───────────┐      injected by apps at composition time
    │     │           │
 sources  │    destinations
 (stripe) │    (pg, sheets)
    │     │           │
    │ stateless-sync  │       ← engine + connector loader + pipeline utils
    │ (protocol only) │         (depends on protocol)
    │     │           │
    │ stateful-sync   │       ← store interfaces + StatefulSync coordinator
    │(stateless-sync) │         (no pg dep — stores are injected)
    │     │           │
    │     │     NO ARROWS BETWEEN
    │     │     SOURCES ↔ DESTINATIONS
    │     │
    │  apps/stateless ─→ stateless-sync
    │  apps/stateful  ─→ apps/stateless + stateful-sync
    │  apps/sync-engine ─→ stateless-sync + store-postgres
    │     │
    └─ apps/supabase  ─→ protocol + source-stripe + destination-postgres
                          + store-postgres + stateful-sync
```

### Canonical dependency layering

| Layer          | Packages                                                             | Depends on                                                                             |
| -------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Core           | `protocol`                                                           | nothing (only `zod`)                                                                   |
| Connectors     | `source-stripe`, `destination-postgres`, `destination-google-sheets` | `protocol` only                                                                        |
| Stateless sync | `stateless-sync`                                                     | `protocol` only                                                                        |
| Pg utilities   | `store-postgres`, `util-postgres`                                    | `pg` only (no protocol dep)                                                            |
| Stateful sync  | `stateful-sync`                                                      | `stateless-sync` only (no `pg` dep)                                                    |
| Stateless app  | `apps/stateless`                                                     | `stateless-sync` only                                                                  |
| Stateful app   | `apps/stateful`                                                      | `apps/stateless` + `stateful-sync`                                                     |
| Published CLI  | `apps/sync-engine`                                                   | `stateless-sync` + `store-postgres`                                                    |
| Integration    | `apps/supabase`                                                      | `protocol`, `source-stripe`, `destination-postgres`, `store-postgres`, `stateful-sync` |

**Key rules:**

- Stateless apps do NOT depend on `stateful-sync`.
- Stateful apps should NOT import directly from `protocol`; types flow through the stateless layer.
- `store-postgres` and `util-postgres` are standalone `pg`-only packages — they have no sync-engine workspace dependencies. Apps inject them at composition time.

## Packages

### `protocol` — core protocol

The shared foundation. Every connector depends on this. It has **zero** dependencies on any source, destination, or infrastructure implementation. Contains only types, interfaces, and Zod schemas.

Contains: message types (`RecordMessage`, `StateMessage`, `CatalogMessage`), `Source`/`Destination` interfaces, Zod schemas (`ConnectorSpecification`, `ConfiguredCatalog`), and message helper functions.

**Package name:** `@stripe/protocol`

**Exports:** Message types, Source/Destination interfaces, Zod schemas, message helpers.

**Dependencies:** `zod` (for schema validation).

### `stateless-sync` — engine + connector loader

Runtime code for executing syncs: the engine (wires source → destination), the connector loader (subprocess adapter + resolution), and pipeline utilities. Re-exports everything from `protocol` so consumers only need one import.

**Package name:** `@stripe/stateless-sync`

**Exports:** Everything from `protocol` + `createEngine`, `createConnectorResolver`, `SyncParams`, `forward`, `collect`, `filterDataMessages`.

**Dependencies:** `@stripe/protocol`, `zod`.

### `source-stripe` — Stripe API source

Reads from the Stripe REST API via list endpoints (backfill), events API (incremental pull), webhooks (push), and WebSocket (live dev). Includes OpenAPI spec parsing for automatic catalog discovery.

**Package name:** `@stripe/source-stripe`

**Exports:** `StripeSource` (implements `Source`), `spec` (Zod config schema), default export.

**Dependencies:** `@stripe/protocol`, `stripe` (Stripe SDK).

**Must NOT depend on:** Any destination or infrastructure package.

### `destination-postgres` — Postgres destination

Writes records into a Postgres database. Creates tables from catalog, upserts records with timestamp protection, handles schema projection (column mapping from JSON schema).

**Package name:** `@stripe/destination-postgres`

**Exports:** `PostgresDestination` (implements `Destination`), `PostgresDestinationWriter`, `spec`, default export.

**Dependencies:** `@stripe/protocol`, `pg`, `yesql`.

**Must NOT depend on:** Any source or infrastructure package.

### `destination-google-sheets` — Google Sheets destination

Writes records into a Google Sheets spreadsheet.

**Package name:** `@stripe/destination-google-sheets`

**Exports:** `SheetsDestination` (implements `Destination`), `spec`, default export.

**Dependencies:** `@stripe/protocol`, `googleapis`.

**Must NOT depend on:** Any source or infrastructure package.

### `store-postgres` — Postgres migration runner

Postgres-specific migration infrastructure. Runs bootstrap and Stripe-specific SQL migrations, handles schema creation, migration tracking, and template rendering.

**Package name:** `@stripe/store-postgres`

**Exports:** `runMigrations`, `runMigrationsFromContent`, `embeddedMigrations`, `genericBootstrapMigrations`, `renderMigrationTemplate`.

**Dependencies:** `pg`.

### `stateful-sync` — store interfaces + StatefulSync

Defines store interfaces (`CredentialStore`, `ConfigStore`, `StateStore`, `LogSink`) with lightweight implementations (memory, file, stderr). The `StatefulSync` coordinator loads config → credentials → state, resolves connectors, creates the engine, runs the sync, persists state, and handles auth_error with credential refresh + retry.

**Package name:** `@stripe/stateful-sync`

**Exports:** Store interfaces + implementations, `StatefulSync`, `resolve`.

**Dependencies:** `@stripe/stateless-sync`.

### `util-postgres` — shared Postgres utilities

Shared Postgres helpers used by multiple packages. Batched upsert with timestamp protection, SQL-based token bucket rate limiter.

**Package name:** `@stripe/util-postgres`

**Exports:** `upsertMany`, `createRateLimiter`.

**Dependencies:** `pg`, `yesql`.

### `ts-cli` — TypeScript module CLI runner

Generic CLI tool that can call any exported function/method from a TypeScript module, with support for stdin piping, positional args, and named args. Used for ad-hoc testing and scripting.

**Package name:** `@stripe/ts-cli`

**Exports:** `run` (CLI entrypoint).

**Dependencies:** None.

### `apps/stateless` — one-shot CLI + API

Runs a single sync from command-line flags or HTTP. No persistence between runs — caller provides all inputs. Thin wrapper around `@stripe/stateless-sync`.

**Package name:** `@stripe/sync-engine-stateless`

**Binaries:** `sync-engine-stateless` (CLI), `sync-engine-stateless-api` (HTTP server)

**Dependencies:** `@stripe/stateless-sync`.

### `apps/stateful` — persistent CLI + API

Wraps the stateless app with `StatefulSync` for credential, config, and state persistence. CRUD endpoints for credentials and syncs, plus streaming sync execution. Uses 4 file-based stores under `--data-dir`.

**Package name:** `@stripe/sync-engine-stateful`

**Binaries:** `sync-engine-stateful` (CLI), `sync-engine-stateful-api` (HTTP server)

**Dependencies:** `@stripe/sync-engine-stateless`, `@stripe/stateful-sync`.

### `apps/sync-engine` — published CLI

The user-facing published CLI. Simple one-shot sync: reads Stripe API key + Postgres URL from flags/env, runs the full pipeline, persists state to `_sync_state` table in Postgres.

**Package name:** `@stripe/sync-engine`

**Binary:** `sync-engine`

**Dependencies:** `@stripe/stateless-sync`, `@stripe/store-postgres`.

### `apps/supabase` — Supabase integration

Deployment target for the Supabase installation flow. Bundles edge functions (Deno runtime) for webhook ingestion, backfill workers, and setup/teardown. Uses `?raw` imports + tsup to bundle edge function code at build time.

**Package name:** `@stripe/integration-supabase`

**Dependencies:** `@stripe/protocol`, `@stripe/source-stripe`, `@stripe/destination-postgres`, `@stripe/store-postgres`, `@stripe/stateful-sync`.

## Isolation rules

| Rule                                                                  | Enforced by                      |
| --------------------------------------------------------------------- | -------------------------------- |
| `source-*` packages never import from `destination-*` packages        | CI lint: disallowed import paths |
| `destination-*` packages never import from `source-*` packages        | CI lint: disallowed import paths |
| `source-*` and `destination-*` only depend on `protocol`              | package.json audit               |
| `protocol` has zero runtime deps beyond `zod`                         | package.json audit               |
| Stateless apps depend on `stateless-sync` only, never `stateful-sync` | package.json audit               |
| Stateful apps depend on their stateless counterpart + `stateful-sync` | package.json audit               |

## pnpm workspace

```yaml
# pnpm-workspace.yaml
packages:
  - packages/*
  - apps/*
```

Packages live under `packages/` (reusable libraries) and `apps/` (deployment targets). The workspace enforces consistent tooling (build, test, lint, format) across all packages.
