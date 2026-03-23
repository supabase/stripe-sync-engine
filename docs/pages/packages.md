# Monorepo Packages

The sync engine decomposes into packages along the architecture's isolation boundaries. The rule is simple: **sources and destinations never depend on each other.** They only depend on the core protocol.

```
packages/
├── sync-protocol/            ← core protocol (message types, interfaces, Zod schemas)
├── stateless-sync/           ← engine, connector loader, test connectors
├── stateful-sync/            ← store interfaces + SyncService coordinator
├── source-stripe/            ← Stripe API source connector
├── source-stripe2/           ← thin conformance wrapper (default export + spec)
├── destination-postgres/     ← Postgres destination connector
├── destination-postgres2/    ← thin conformance wrapper (default export + spec)
├── destination-google-sheets/← Google Sheets destination connector
├── destination-google-sheets2/ ← thin conformance wrapper
├── store-postgres/           ← Postgres migration runner + embedded migrations
├── util-postgres/            ← shared Postgres utilities (upsert, rate limiter)
└── ts-cli/                   ← generic TypeScript module CLI runner
apps/
├── stateless-cli/            ← one-shot CLI (no persistence between runs)
├── stateless-api/            ← one-shot HTTP API (SSE streaming)
├── stateful-cli/             ← persistent CLI (credentials, config, state on disk)
├── stateful-api/             ← persistent HTTP API (CRUD + SSE sync execution)
└── supabase/                 ← Supabase integration (edge functions + deployment)
tests/
└── conformance/              ← cross-package connector conformance tests
```

## Dependency graph

```
  ┌────────────────┐       ┌──────────────┐  ┌──────────────┐
  │ sync-protocol  │       │store-postgres │  │ util-postgres │
  │  (types only)  │       │  (pg only)    │  │  (pg only)    │
  └───────┬────────┘       └──────────────┘  └──────────────┘
          │                  standalone — no sync-protocol dep
    ┌─────┼───────────┐      injected by apps at composition time
    │     │           │
 sources  │    destinations
 (stripe) │    (pg, sheets)
    │     │           │
    │ stateless-sync  │       ← engine + connector loader + test connectors
    │ (protocol only) │         (depends on sync-protocol)
    │     │           │
    │ stateful-sync   │       ← store interfaces + coordinator
    │(stateless-sync) │         (no pg dep — stores are injected)
    │     │           │
    │     │     NO ARROWS BETWEEN
    │     │     SOURCES ↔ DESTINATIONS
    │     │
    │  stateless-cli  ─→ stateless-sync
    │  stateless-api  ─→ stateless-sync
    │     │
    │  stateful-cli   ─→ stateless-cli + stateful-sync
    │  stateful-api   ─→ stateless-api + stateful-sync
    │     │
    └─ supabase       ─→ source-stripe + destination-postgres
                          + store-postgres + stateful-sync
```

### Canonical dependency layering

| Layer          | Packages                                                             | Depends on                                                                                  |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Core           | `sync-protocol`                                                      | nothing (only `zod`)                                                                        |
| Connectors     | `source-stripe`, `destination-postgres`, `destination-google-sheets` | `sync-protocol` only                                                                        |
| Stateless sync | `stateless-sync`                                                     | `sync-protocol` only                                                                        |
| Pg utilities   | `store-postgres`, `util-postgres`                                    | `pg` only (no sync-protocol dep)                                                            |
| Stateful sync  | `stateful-sync`                                                      | `stateless-sync` only (no `pg` dep)                                                         |
| Stateless apps | `stateless-cli`, `stateless-api`                                     | `stateless-sync` only                                                                       |
| Stateful apps  | `stateful-cli`, `stateful-api`                                       | stateless counterpart + `stateful-sync`                                                     |
| Integration    | `apps/supabase`                                                      | `sync-protocol`, `source-stripe`, `destination-postgres`, `store-postgres`, `stateful-sync` |

**Key rules:**

- Stateless apps do NOT depend on `stateful-sync`.
- Stateful apps should NOT import directly from `sync-protocol`; types flow through the stateless layer.
- `store-postgres` and `util-postgres` are standalone `pg`-only packages — they have no sync-engine workspace dependencies. Apps inject them at composition time.

## Packages

### `sync-protocol` — core protocol

The shared foundation. Every connector depends on this. It has **zero** dependencies on any source, destination, or infrastructure implementation. Contains only types, interfaces, and Zod schemas.

Contains: message types (`RecordMessage`, `StateMessage`, `CatalogMessage`), `Source`/`Destination` interfaces, Zod schemas (`SyncEngineParams`, `SyncParams`, `ConnectorSpecification`), and message helper functions.

**Exports:** Message types, Source/Destination interfaces, Zod schemas, message helpers.

**Dependencies:** `zod` (for schema validation).

### `stateless-sync` — engine + connector loader

Runtime code for executing syncs: the engine (wires source → destination), the connector loader (dynamic import + resolution), and built-in test connectors. Re-exports everything from `sync-protocol` so consumers only need one import.

**Exports:** Everything from `sync-protocol` + `createEngine`, `createConnectorResolver`, `SyncParams`, `testSource`, `testDestination`.

**Dependencies:** `sync-protocol`, `zod`.

### `source-stripe` — Stripe API source

Reads from the Stripe REST API via list endpoints (backfill), events API (incremental pull), webhooks (push), and WebSocket (live dev). Includes OpenAPI spec parsing for automatic catalog discovery.

**Exports:** `StripeSource` (implements `Source`), `spec` (Zod config schema), default export.

**Dependencies:** `sync-protocol`, `stripe` (Stripe SDK).

**Must NOT depend on:** Any destination or infrastructure package.

### `destination-postgres` — Postgres destination

Writes records into a Postgres database. Creates tables from catalog, upserts records with timestamp protection, handles schema projection (column mapping from JSON schema).

**Exports:** `PostgresDestination` (implements `Destination`), `PostgresDestinationWriter`, `spec`, default export.

**Dependencies:** `sync-protocol`, `pg`, `yesql`.

**Must NOT depend on:** Any source or infrastructure package.

### `destination-google-sheets` — Google Sheets destination

Writes records into a Google Sheets spreadsheet.

**Exports:** `SheetsDestination` (implements `Destination`), `spec`, default export.

**Dependencies:** `sync-protocol`, `googleapis`.

**Must NOT depend on:** Any source or infrastructure package.

### `store-postgres` — Postgres migration runner

Postgres-specific migration infrastructure extracted from sync-service. Runs bootstrap and Stripe-specific SQL migrations, handles schema creation, migration tracking, and template rendering.

**Exports:** `runMigrations`, `runMigrationsFromContent`, `embeddedMigrations`, `genericBootstrapMigrations`, `renderMigrationTemplate`.

**Dependencies:** `pg`.

### `stateful-sync` — store interfaces + SyncService

Defines store interfaces (`CredentialStore`, `ConfigStore`, `StateStore`, `LogSink`) with lightweight implementations (memory, file, env, stderr). The `SyncService` coordinator loads config → credentials → state, resolves connectors, creates the engine, runs the sync, persists state, and handles auth_error with credential refresh + retry.

**Exports:** Store interfaces + implementations, `SyncService`, `resolve`.

**Dependencies:** `stateless-sync`.

### `util-postgres` — shared Postgres utilities

Shared Postgres helpers used by multiple packages. Batched upsert with timestamp protection, SQL-based token bucket rate limiter.

**Exports:** `upsertMany`, `createRateLimiter`.

**Dependencies:** `pg`, `yesql`.

### `ts-cli` — TypeScript module CLI runner

Generic CLI tool that can call any exported function/method from a TypeScript module, with support for stdin piping, positional args, and named args. Used for ad-hoc testing and scripting.

**Exports:** `run` (CLI entrypoint).

**Dependencies:** None.

### `stateless-cli` — one-shot CLI

Runs a single sync from command-line flags. No persistence between runs — caller provides all inputs (source type, destination type, config via env vars). Thin wrapper around `stateless-sync`'s engine.

**Dependencies:** `stateless-sync`.

### `stateless-api` — one-shot HTTP API

HTTP API that runs a single sync via SSE streaming. Same one-shot semantics as stateless-cli but over HTTP.

**Dependencies:** `stateless-sync`, `hono`.

### `stateful-cli` — persistent CLI

Wraps stateless-cli with `SyncService` for credential, config, and state persistence. Reads credentials from env, config from flags, state from memory.

**Dependencies:** `stateless-cli`, `stateful-sync`.

### `stateful-api` — persistent HTTP API

Wraps stateless-api with `SyncService`. CRUD endpoints for credentials and syncs, plus SSE sync execution. The management plane (REST CRUD) and execution plane (running syncs) coexist in one app.

**Dependencies:** `stateless-api`, `stateful-sync`, `hono`, `@hono/zod-openapi`.

### `apps/supabase` — Supabase integration

Deployment target for the Supabase dashboard installation flow. Bundles edge functions (Deno runtime) for webhook ingestion, backfill workers, and setup/teardown. Uses `?raw` imports + esbuild to bundle edge function code at build time.

**Dependencies:** `sync-protocol`, `source-stripe`, `destination-postgres`, `store-postgres`, `stateful-sync`.

## `*2` wrapper packages

`source-stripe2`, `destination-postgres2`, `destination-google-sheets2` are thin conformance wrappers that re-export their parent connector with the standard `default` + `spec` pattern. They exist to satisfy the connector conformance contract while keeping the underlying connector's API flexible.

## Isolation rules

| Rule                                                                  | Enforced by                      |
| --------------------------------------------------------------------- | -------------------------------- |
| `source-*` packages never import from `destination-*` packages        | CI lint: disallowed import paths |
| `destination-*` packages never import from `source-*` packages        | CI lint: disallowed import paths |
| `source-*` and `destination-*` only depend on `sync-protocol`         | package.json audit               |
| `sync-protocol` has zero runtime deps beyond `zod`                    | package.json audit               |
| Stateless apps depend on `stateless-sync` only, never `stateful-sync` | package.json audit               |
| Stateful apps depend on their stateless counterpart + `stateful-sync` | package.json audit               |

## pnpm workspace

```yaml
# pnpm-workspace.yaml
packages:
  - packages/*
  - apps/*
  - tests/*
```

Packages live under `packages/` (reusable libraries), `apps/` (deployment targets), and `tests/` (cross-package test suites). The workspace enforces consistent tooling (build, test, lint, format) across all packages.
