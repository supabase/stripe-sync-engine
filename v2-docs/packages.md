# Monorepo Packages

The sync engine decomposes into packages along the architecture's isolation boundaries. The rule is simple: **sources and destinations never depend on each other.** They only depend on the core protocol.

```
packages/
├── sync-protocol/            ← core protocol (message types, interfaces, engine)
├── source-stripe/            ← Stripe API source connector
├── source-stripe2/           ← thin conformance wrapper (default export + spec)
├── destination-postgres/     ← Postgres destination connector
├── destination-postgres2/    ← thin conformance wrapper (default export + spec)
├── destination-google-sheets/← Google Sheets destination connector
├── destination-google-sheets2/ ← thin conformance wrapper
├── store-postgres/           ← Postgres migration runner + embedded migrations
├── sync-service/             ← store interfaces + SyncService coordinator
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
                   ┌────────────────┐
                   │ sync-protocol  │   ← message types, Source/Destination
                   │    (core)      │      interfaces, engine, connector loader
                   └───────┬────────┘
                           │
         ┌─────────────────┼─────────────────────┐
         │                 │                      │
   ┌─────┴──────┐  ┌──────┴───────┐   ┌──────────┴──────────┐
   │  sources   │  │ destinations │   │  infrastructure      │
   ├────────────┤  ├──────────────┤   ├─────────────────────┤
   │ stripe     │  │ postgres     │   │ store-postgres       │
   │            │  │ sheets       │   │ sync-service         │
   └────────────┘  └──────────────┘   │ util-postgres        │
         │               │            └──────────┬──────────┘
         │    NO ARROWS BETWEEN                  │
         │    SOURCES ↔ DESTINATIONS             │
         │                                       │
         └─────────────────┬─────────────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
     ┌────────┴─────────┐    ┌─────────┴──────────┐
     │  stateless apps  │    │   stateful apps     │
     ├──────────────────┤    ├────────────────────┤
     │ stateless-cli    │    │ stateful-cli        │
     │ stateless-api    │    │ stateful-api        │
     └──────────────────┘    └────────────────────┘
              │                        │
              │    stateful apps       │
              │    depend on their     │
              └── stateless counterpart┘
                   + sync-service
```

### Canonical dependency layering

| Layer          | Packages                                                             | Depends on                                                                                 |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Core           | `sync-protocol`                                                      | nothing                                                                                    |
| Connectors     | `source-stripe`, `destination-postgres`, `destination-google-sheets` | `sync-protocol` only                                                                       |
| Infrastructure | `store-postgres`, `sync-service`, `util-postgres`                    | `sync-protocol` (sync-service)                                                             |
| Stateless apps | `stateless-cli`, `stateless-api`                                     | `sync-protocol` only                                                                       |
| Stateful apps  | `stateful-cli`, `stateful-api`                                       | stateless counterpart + `sync-service`                                                     |
| Integration    | `apps/supabase`                                                      | `sync-protocol`, `source-stripe`, `destination-postgres`, `store-postgres`, `sync-service` |

**Key rule:** Stateless apps do NOT depend on `sync-service`. Stateful apps should NOT import directly from `sync-protocol`; types flow through the stateless layer.

## Packages

### `sync-protocol` — core protocol

The shared foundation. Every connector depends on this. It has **zero** dependencies on any source, destination, or infrastructure implementation.

Contains: message types (`RecordMessage`, `StateMessage`, `CatalogMessage`), `Source`/`Destination` interfaces, the sync `engine` (wires source → destination), the connector `loader` (dynamic import + resolution), and built-in test connectors (`testSource`, `testDestination`).

**Exports:** Message types, Source/Destination interfaces, `createEngine`, `createConnectorResolver`, `SyncParams`, test connectors.

**Dependencies:** `zod` (for schema validation).

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

### `sync-service` — store interfaces + SyncService

Defines store interfaces (`CredentialStore`, `ConfigStore`, `StateStore`, `LogSink`) with lightweight implementations (memory, file, env, stderr). The `SyncService` coordinator loads config → credentials → state, resolves connectors, creates the engine, runs the sync, persists state, and handles auth_error with credential refresh + retry.

**Exports:** Store interfaces + implementations, `SyncService`, `resolve`.

**Dependencies:** `sync-protocol`.

### `util-postgres` — shared Postgres utilities

Shared Postgres helpers used by multiple packages. Batched upsert with timestamp protection, SQL-based token bucket rate limiter.

**Exports:** `upsertMany`, `createRateLimiter`.

**Dependencies:** `pg`, `yesql`.

### `ts-cli` — TypeScript module CLI runner

Generic CLI tool that can call any exported function/method from a TypeScript module, with support for stdin piping, positional args, and named args. Used for ad-hoc testing and scripting.

**Exports:** `run` (CLI entrypoint).

**Dependencies:** None.

### `stateless-cli` — one-shot CLI

Runs a single sync from command-line flags. No persistence between runs — caller provides all inputs (source type, destination type, config via env vars). Thin wrapper around `sync-protocol`'s engine.

**Dependencies:** `sync-protocol`.

### `stateless-api` — one-shot HTTP API

HTTP API that runs a single sync via SSE streaming. Same one-shot semantics as stateless-cli but over HTTP.

**Dependencies:** `sync-protocol`, `hono`.

### `stateful-cli` — persistent CLI

Wraps stateless-cli with `SyncService` for credential, config, and state persistence. Reads credentials from env, config from flags, state from memory.

**Dependencies:** `stateless-cli`, `sync-service`.

### `stateful-api` — persistent HTTP API

Wraps stateless-api with `SyncService`. CRUD endpoints for credentials and syncs, plus SSE sync execution. The management plane (REST CRUD) and execution plane (running syncs) coexist in one app.

**Dependencies:** `stateless-api`, `sync-service`, `hono`, `@hono/zod-openapi`.

### `apps/supabase` — Supabase integration

Deployment target for the Supabase dashboard installation flow. Bundles edge functions (Deno runtime) for webhook ingestion, backfill workers, and setup/teardown. Uses `?raw` imports + esbuild to bundle edge function code at build time.

**Dependencies:** `sync-protocol`, `source-stripe`, `destination-postgres`, `store-postgres`, `sync-service`.

## `*2` wrapper packages

`source-stripe2`, `destination-postgres2`, `destination-google-sheets2` are thin conformance wrappers that re-export their parent connector with the standard `default` + `spec` pattern. They exist to satisfy the connector conformance contract while keeping the underlying connector's API flexible.

## Isolation rules

| Rule                                                                 | Enforced by                      |
| -------------------------------------------------------------------- | -------------------------------- |
| `source-*` packages never import from `destination-*` packages       | CI lint: disallowed import paths |
| `destination-*` packages never import from `source-*` packages       | CI lint: disallowed import paths |
| `source-*` and `destination-*` only depend on `sync-protocol`        | package.json audit               |
| `sync-protocol` has zero runtime deps beyond `zod`                   | package.json audit               |
| Stateless apps depend on `sync-protocol` only, never `sync-service`  | package.json audit               |
| Stateful apps depend on their stateless counterpart + `sync-service` | package.json audit               |

## pnpm workspace

```yaml
# pnpm-workspace.yaml
packages:
  - packages/*
  - apps/*
  - tests/*
```

Packages live under `packages/` (reusable libraries), `apps/` (deployment targets), and `tests/` (cross-package test suites). The workspace enforces consistent tooling (build, test, lint, format) across all packages.
