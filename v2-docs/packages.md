# Monorepo Packages

The sync engine decomposes into packages along the architecture's isolation boundaries. The rule is simple: **sources and destinations never depend on each other.** They only depend on the core protocol.

```
packages/
├── sync-protocol/            ← core protocol (message types, interfaces)
├── source-stripe/            ← Stripe API source (includes webhook ingress + CLI)
├── destination-postgres/     ← Postgres destination (+ CLI)
├── destination-google-sheets/← Google Sheets destination (+ CLI)
├── orchestrator-postgres/    ← orchestrator with Postgres state (+ CLI)
├── orchestrator-fs/          ← orchestrator with filesystem state (+ CLI)
├── sync-service/             ← Sync API service (Layer 3)
└── db-service/               ← DB API service (Layer 4)
apps/
└── supabase/                 ← Supabase integration (edge functions + dashboard)
docker-compose.yml            ← root-level: shared Postgres + Stripe fixtures
```

> **No standalone `cli` package.** Each package owns its own CLI entrypoint (e.g. `source-stripe` exposes `source read`, `destination-postgres` exposes `dest write`). This aligns with the Unix-pipe architecture where piped commands read like native commands: `source read | dest write`.

## Dependency graph

```
                   ┌────────────────┐
                   │ sync-protocol  │   ← message types, Source/Destination/
                   │    (core)      │      Orchestrator interfaces, Transform
                   └───────┬────────┘
                          │
          ┌───────────────┼───────────────────┐
          │               │                   │
    ┌─────┴──────┐  ┌─────┴──────┐   ┌───────┴─────────┐
    │  sources   │  │destinations│   │  orchestrators   │
    ├────────────┤  ├────────────┤   ├─────────────────┤
    │ stripe     │  │ postgres   │   │ postgres         │
    │            │  │ sheets     │   │ fs               │
    └────────────┘  └────────────┘   └───────┬─────────┘
          │               │                   │
          │      NO ARROWS BETWEEN            │
          │      SOURCES ↔ DESTINATIONS       │
          │                                   │
          └───────────────┬───────────────────┘
                          │
                   ┌──────┴───────┐
                   │ sync-service │   ← wires sources + destinations +
                   │  (Layer 3)   │      orchestrators together
                   └──────┬───────┘
                          │
                   ┌──────┴───────┐
                   │  db-service  │   ← convenience layer on top
                   │  (Layer 4)   │
                   └──────────────┘
```

## Packages

### `sync-protocol` — core protocol

The shared foundation. Every other package depends on this. It has **zero** dependencies on any source, destination, or orchestrator implementation.

```
sync-protocol/
├── src/
│   ├── types.ts          # Message, RecordMessage, StateMessage, CatalogMessage, etc.
│   ├── interfaces.ts     # Source, Destination, Transform, Orchestrator
│   ├── compose.ts        # Transform composition
│   └── filters.ts        # filter_data_messages, message type guards
├── package.json
└── tsconfig.json
```

**Exports:** Message types, Source/Destination/Transform/Orchestrator interfaces, message type guards, transform composition utilities.

**Dependencies:** None (zero runtime deps).

### `source-stripe` — Stripe API source

Reads from the Stripe REST API and webhooks/WebSocket. Includes an HTTP server for webhook ingestion — multi-tenant merchant routing is a deployment concern layered on top, not built into the source itself.

```
source-stripe/
├── src/
│   ├── index.ts          # StripeSource implements Source
│   ├── backfill.ts       # List API pagination
│   ├── live.ts           # Webhook + WebSocket event ingestion
│   ├── server.ts         # Webhook HTTP server (receives Stripe POSTs)
│   ├── catalog.ts        # Stream discovery (known Stripe object types)
│   ├── cli.ts            # CLI entrypoint (source read, source discover)
│   └── streams/          # Per-stream config (customers, invoices, etc.)
├── test/
│   ├── discover.test.ts
│   ├── backfill.test.ts
│   ├── live.test.ts
│   └── resume.test.ts
└── package.json
```

**Exports:** `StripeSource` (implements `Source`).

**Dependencies:** `sync-protocol`, `stripe` (Stripe SDK).

**Must NOT depend on:** Any destination or orchestrator package.

### `destination-postgres` — Postgres destination

Writes records into a Postgres database. Creates tables from catalog, upserts records, confirms checkpoints.

```
destination-postgres/
├── src/
│   ├── index.ts          # PostgresDestination implements Destination
│   ├── schema.ts         # CatalogMessage → CREATE TABLE DDL
│   ├── writer.ts         # Batched upsert logic
│   └── migrations.ts     # Schema evolution (ALTER TABLE for new columns)
├── test/
│   ├── schema-setup.test.ts
│   ├── upsert.test.ts
│   ├── checkpoint.test.ts
│   └── schema-evolution.test.ts
└── package.json
```

**Exports:** `PostgresDestination` (implements `Destination`).

**Dependencies:** `sync-protocol`, `pg`.

**Must NOT depend on:** Any source or orchestrator package.

### `destination-google-sheets` — Google Sheets destination

Writes records into a Google Sheets spreadsheet.

```
destination-google-sheets/
├── src/
│   ├── index.ts          # SheetsDestination implements Destination
│   ├── schema.ts         # CatalogMessage → sheet tabs + headers
│   └── writer.ts         # Batched append with rate limit handling
├── test/
│   ├── schema-setup.test.ts
│   ├── append.test.ts
│   └── rate-limit.test.ts
└── package.json
```

**Exports:** `SheetsDestination` (implements `Destination`).

**Dependencies:** `sync-protocol`, `googleapis`.

**Must NOT depend on:** Any source or orchestrator package.

### `orchestrator-postgres` — Postgres-backed orchestrator

Persists sync config and checkpoint state to Postgres. Routes messages between source and destination.

```
orchestrator-postgres/
├── src/
│   ├── index.ts          # PostgresOrchestrator implements Orchestrator
│   ├── state.ts          # Sync.state persistence (upsert per stream)
│   ├── config.ts         # Sync config load/save
│   └── router.ts         # Message filtering and routing
├── test/
│   ├── state-roundtrip.test.ts
│   ├── message-routing.test.ts
│   └── same-db.test.ts   # orchestrator + destination on same Postgres
└── package.json
```

**Exports:** `PostgresOrchestrator` (implements `Orchestrator`).

**Dependencies:** `sync-protocol`, `pg`.

### `orchestrator-fs` — Filesystem-backed orchestrator

Same interface as orchestrator-postgres but backed by JSON files on disk. For local dev and standalone CLI.

```
orchestrator-fs/
├── src/
│   ├── index.ts          # FsOrchestrator implements Orchestrator
│   ├── state.ts          # Sync.state persistence (JSON files)
│   ├── config.ts         # Sync config load/save
│   └── router.ts         # Message filtering and routing (shared logic)
├── test/
│   ├── state-roundtrip.test.ts
│   └── message-routing.test.ts
└── package.json
```

**Exports:** `FsOrchestrator` (implements `Orchestrator`).

**Dependencies:** `sync-protocol`.

### `sync-service` — Sync API (Layer 3)

The Sync API service. CRUD for credentials and syncs. Wires sources, destinations, and orchestrators together. This is the **only** package that knows about specific source/destination implementations — it's the composition root.

```
sync-service/
├── src/
│   ├── index.ts          # Service entrypoint
│   ├── api/
│   │   ├── credentials.ts # POST/GET/PATCH/DELETE /credentials
│   │   └── syncs.ts       # POST/GET/PATCH/DELETE /syncs
│   ├── registry.ts       # Source/Destination/Orchestrator registry
│   └── scheduler.ts      # Sync scheduling and lifecycle
├── test/
│   ├── credentials.test.ts
│   ├── syncs.test.ts
│   └── lifecycle.test.ts
└── package.json
```

**Exports:** Sync API routes, service factory.

**Dependencies:** `sync-protocol`, all source/destination/orchestrator packages (as the composition root).

### `db-service` — DB API (Layer 4)

The managed database service. Provisions infrastructure, manages users, enriches responses with sync status. Built on top of sync-service.

```
db-service/
├── src/
│   ├── index.ts          # Service entrypoint
│   ├── api/
│   │   ├── databases.ts  # POST/GET/DELETE /v2/data/databases
│   │   ├── users.ts      # POST/GET/DELETE /v2/data/databases/:id/users
│   │   └── query.ts      # POST /v2/data/databases/:id/query
│   ├── provisioner.ts    # RDS/DuckDB provisioning
│   └── enrichment.ts     # SyncSummary lookup from sync-service
├── test/
│   ├── databases.test.ts
│   ├── users.test.ts
│   ├── query.test.ts
│   └── enrichment.test.ts
└── package.json
```

**Exports:** DB API routes, service factory.

**Dependencies:** `sync-protocol` (for types), `sync-service` (for sync enrichment).

### `apps/supabase` — Supabase integration

Deployment target for the Supabase dashboard installation flow. Not a reusable library — this is an application that ties edge functions, a dashboard UI, and a setup client together for the Supabase platform.

```
apps/supabase/
├── edge-functions/           # Deno runtime (deployed to Supabase Edge Functions)
│   ├── webhook/              # Stripe webhook receiver → pgmq queue
│   ├── worker/               # Dequeues from pgmq, runs sync pipeline
│   ├── setup/                # Provisions pg_cron, pgmq queues, stores secrets
│   └── data-worker/          # Dataset sync worker
├── dashboard/                # Next.js app (deployed on Vercel)
│   └── ...                   # "Install Stripe Sync" UI, sync status, config
├── setup-client/             # Deploys edge functions, configures pg_cron,
│   └── ...                   #   creates pgmq queues, stores secrets
├── package.json
└── tsconfig.json
```

**Edge functions (Deno):** Webhook receiver accepts Stripe POSTs and enqueues into pgmq. Worker dequeues and runs the source → destination pipeline. Setup function bootstraps the infrastructure (pg_cron schedules, pgmq queues, Vault secrets).

**Dashboard (Next.js):** The "Install Stripe Sync" UI that Supabase users interact with. Deployed on Vercel. Collects Stripe API key, shows sync status, and manages configuration.

**Setup client:** Orchestrates initial deployment — deploys edge functions, configures pg_cron, creates pgmq queues, and stores secrets in Supabase Vault.

**Dependencies:** `sync-protocol` (for types), Supabase/Deno runtime, pgmq, pg_cron.

## Isolation rules

| Rule                                                                     | Enforced by                      |
| ------------------------------------------------------------------------ | -------------------------------- |
| `source-*` packages never import from `destination-*` packages           | CI lint: disallowed import paths |
| `destination-*` packages never import from `source-*` packages           | CI lint: disallowed import paths |
| `source-*` and `destination-*` only depend on `sync-protocol`            | package.json audit               |
| `sync-protocol` has zero runtime dependencies                            | package.json audit               |
| Only `sync-service` imports specific source/destination implementations  | package.json audit               |
| Orchestrator packages don't import source or destination implementations | package.json audit               |

## pnpm workspace

```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

Packages live under `packages/` (reusable libraries and services) and `apps/` (deployment targets). The workspace enforces consistent tooling (build, test, lint, format) across all packages.

## docker-compose.yml (root level)

One compose file at the repo root. Packages share infrastructure — no per-package duplication.

```yaml
# docker-compose.yml
services:
  # Shared Postgres — used by destination-postgres, orchestrator-postgres,
  # and the cross-cutting same-DB scenario
  postgres:
    image: postgres:16
    ports:
      - '5432:5432'
    environment:
      POSTGRES_DB: sync_engine_test
      POSTGRES_HOST_AUTH_METHOD: trust
    volumes:
      - pgdata:/var/lib/postgresql/data

  # Stripe mock — used by source-stripe integration tests
  stripe-mock:
    image: stripe/stripe-mock:latest
    ports:
      - '12111:12111'
      - '12112:12112'

volumes:
  pgdata:
```

**Why root-level:**

- `orchestrator-postgres` + `destination-postgres` same-DB scenario needs them on one Postgres instance
- `source-stripe` integration tests need stripe-mock
- No duplication of Postgres config across packages
- `docker compose up` gives you everything; `docker compose up postgres` for just the DB

**Per-package test scripts** reference the shared services:

```jsonc
// packages/destination-postgres/package.json
{
  "scripts": {
    "test": "vitest",
    "test:integration": "vitest --config vitest.integration.config.ts",
    // integration tests assume postgres is running on localhost:5432
  },
}
```
