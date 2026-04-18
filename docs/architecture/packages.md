# Monorepo Packages

The sync engine decomposes into packages along the architecture's isolation boundaries. The rule is simple: **sources and destinations never depend on each other.** They only depend on the core protocol.

```
packages/
├── protocol/                 ← core protocol (message types, interfaces, Zod schemas)
├── source-stripe/            ← Stripe API source connector
├── destination-postgres/     ← Postgres destination connector
├── destination-google-sheets/← Google Sheets destination connector
├── state-postgres/           ← Postgres state store (migration runner + embedded migrations)
├── util-postgres/            ← shared Postgres utilities (upsert, rate limiter)
└── ts-cli/                   ← generic TypeScript module CLI runner (private)
apps/
├── engine/                   ← sync engine library + stateless CLI + HTTP API
├── service/                  ← stateful service (credential/state management)
└── supabase/                 ← Supabase edge functions (Deno runtime)
```

## Dependency graph

```
  ┌────────────────┐       ┌──────────────┐  ┌──────────────┐
  │   protocol     │       │state-postgres │  │ util-postgres │
  │  (types only)  │       │  (pg only)    │  │  (pg only)    │
  └───────┬────────┘       └──────────────┘  └──────────────┘
          │                  standalone — no protocol dep
    ┌─────┼───────────┐      injected by apps at composition time
    │     │           │
 sources  │    destinations
 (stripe) │    (pg, sheets)
    │     │           │
    │  apps/engine    │       ← engine + connector loader + pipeline utils + CLI + API
    │  (protocol only)│         (depends on protocol, state-postgres)
    │     │           │
    │  apps/service   │       ← store interfaces + StatefulSync coordinator
    │  (engine only)  │         (no pg dep — stores are injected by CLI/API)
    │     │           │
    │     │     NO ARROWS BETWEEN
    │     │     SOURCES ↔ DESTINATIONS
    │     │
    └─ apps/supabase  ─→ protocol + source-stripe + destination-postgres
                          + state-postgres + apps/engine
```

### Canonical dependency layering

| Layer        | Package                                                              | Depends on                                                         |
| ------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Core         | `protocol`                                                           | nothing (only `zod`)                                               |
| Connectors   | `source-stripe`, `destination-postgres`, `destination-google-sheets` | `protocol` only                                                    |
| Pg utilities | `state-postgres`, `util-postgres`                                    | `pg` only (no protocol dep)                                        |
| Engine + CLI | `apps/engine`                                                        | `protocol`, `state-postgres`, connectors                           |
| Service      | `apps/service`                                                       | `apps/engine`                                                      |
| Integration  | `apps/supabase`                                                      | `protocol`, `source-stripe`, `destination-postgres`, `apps/engine` |

**Key rules:**

- Connectors only depend on `protocol` — never on each other or on infrastructure.
- `state-postgres` and `util-postgres` are standalone `pg`-only packages — they have no sync-engine workspace dependencies. Apps inject them at composition time.
- `apps/service` does NOT depend directly on `pg`; Postgres stores are injected by the CLI/API entrypoints.

## Packages

### `protocol` — core protocol

The shared foundation. Every connector depends on this. It has **zero** dependencies on any source, destination, or infrastructure implementation. Contains only types, interfaces, and Zod schemas.

Contains: message types (`RecordMessage`, `StateMessage`, `CatalogMessage`), `Source`/`Destination` interfaces, Zod schemas (`ConnectorSpecification`, `ConfiguredCatalog`), and message helper functions.

**Package name:** `@stripe/sync-protocol`

**Exports:** Message types, Source/Destination interfaces, Zod schemas, message helpers.

**Dependencies:** `zod` (for schema validation).

### `source-stripe` — Stripe API source

Reads from the Stripe REST API via list endpoints (backfill), events API (incremental pull), webhooks (push), and WebSocket (live dev). Includes OpenAPI spec parsing for automatic catalog discovery.

**Package name:** `@stripe/sync-source-stripe`

**Exports:** `StripeSource` (implements `Source`), `spec` (Zod config schema), default export.

**Dependencies:** `@stripe/sync-protocol`, `stripe` (Stripe SDK).

**Must NOT depend on:** Any destination or infrastructure package.

### `destination-postgres` — Postgres destination

Writes records into a Postgres database. Creates tables from catalog, upserts records with timestamp protection, handles schema projection (column mapping from JSON schema).

**Package name:** `@stripe/sync-destination-postgres`

**Exports:** `PostgresDestination` (implements `Destination`), `PostgresDestinationWriter`, `spec`, default export.

**Dependencies:** `@stripe/sync-protocol`, `pg`, `yesql`.

**Must NOT depend on:** Any source or infrastructure package.

### `destination-google-sheets` — Google Sheets destination

Writes records into a Google Sheets spreadsheet.

**Package name:** `@stripe/sync-destination-google-sheets`

**Exports:** `SheetsDestination` (implements `Destination`), `spec`, default export.

**Dependencies:** `@stripe/sync-protocol`, `googleapis`.

**Must NOT depend on:** Any source or infrastructure package.

### `state-postgres` — Postgres state store

Postgres-specific migration infrastructure. Runs bootstrap and Stripe-specific SQL migrations, handles schema creation, migration tracking, and template rendering.

**Package name:** `@stripe/sync-state-postgres`

**Exports:** `runMigrations`, `runMigrationsFromContent`, `embeddedMigrations`, `genericBootstrapMigrations`, `renderMigrationTemplate`.

**Dependencies:** `pg`.

### `util-postgres` — shared Postgres utilities

Shared Postgres helpers used by multiple packages. Batched upsert with timestamp protection, SQL-based token bucket rate limiter.

**Package name:** `@stripe/sync-util-postgres`

**Exports:** `upsertMany`, `createRateLimiter`.

**Dependencies:** `pg`, `yesql`.

### `ts-cli` — TypeScript module CLI runner

Generic CLI tool that can call any exported function/method from a TypeScript module, with support for stdin piping, positional args, and named args. Used for ad-hoc testing and scripting.

**Package name:** `@stripe/sync-ts-cli` (private)

**Exports:** `run` (CLI entrypoint).

**Dependencies:** None.

### `apps/engine` — sync engine library + stateless CLI + HTTP API

The core of the system. Contains the engine that wires source → destination, the connector loader (subprocess adapter + resolution), and pipeline utilities. Also provides the `sync-engine` binary (CLI) and an HTTP API server.

Published as the user-facing npm package.

**Package name:** `@stripe/sync-engine`

**Exports:**

- `"."` — library: `createEngine`, `createConnectorResolver`, `SyncParams`, `forward`, `collect`, `filterDataMessages`, `sourceTest`, `destinationTest`, everything from `protocol`
- `"./cli"` — CLI `CommandDef` (citty program, no side effects)
- `"./api"` — `createApp` factory (Hono app, no side effects)

**Binaries:** `sync-engine` → `dist/bin/sync-engine.js`; `sync-engine-serve` → `dist/bin/serve.js`

**Dependencies:** `@stripe/sync-protocol`, `@stripe/sync-state-postgres`, connectors, `citty`, `hono`, `dotenv`.

### `apps/service` — stateful sync service

Wraps the engine with credential management and state persistence. Defines store interfaces (`CredentialStore`, `StateStore`, `LogSink`) with file-based implementations. The `StatefulSync` coordinator loads config → credentials → state, resolves connectors, runs the engine, and persists output state.

**Package name:** `@stripe/sync-service`

**Exports:** Store interfaces + implementations, `StatefulSync`.

**Binary:** `sync-service`

**Dependencies:** `@stripe/sync-engine`.

### `apps/supabase` — Supabase integration

Deployment target for the Supabase installation flow. Bundles edge functions (Deno runtime) for webhook ingestion, backfill workers, and setup/teardown. Uses `?raw` imports + tsup to bundle edge function code at build time.

**Package name:** `@stripe/sync-integration-supabase`

**Dependencies:** `@stripe/sync-protocol`, `@stripe/sync-source-stripe`, `@stripe/sync-destination-postgres`, `@stripe/sync-state-postgres`, `@stripe/sync-engine`.

## Isolation rules

| Rule                                                           | Enforced by                      |
| -------------------------------------------------------------- | -------------------------------- |
| `source-*` packages never import from `destination-*` packages | CI lint: disallowed import paths |
| `destination-*` packages never import from `source-*` packages | CI lint: disallowed import paths |
| `source-*` and `destination-*` only depend on `protocol`       | package.json audit               |
| `protocol` has zero runtime deps beyond `zod`                  | package.json audit               |
| `apps/service` does not depend directly on `pg`                | package.json audit               |

## pnpm workspace

```yaml
# pnpm-workspace.yaml
packages:
  - packages/*
  - apps/*
```

Packages live under `packages/` (reusable libraries) and `apps/` (deployment targets). The workspace enforces consistent tooling (build, test, lint, format) across all packages.
