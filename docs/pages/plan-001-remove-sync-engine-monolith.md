# Plan: Remove `packages/sync-engine` and redistribute code

## Context

`packages/sync-engine` is a 61k LoC monolith that predates the clean protocol-based package architecture (`sync-protocol`, `source-stripe`, `destination-postgres`, `orchestrator-postgres`). It acts as a god package — composing all layers, owning the database client, CLI, webhook handler, Sigma, Supabase deployment, and the core StripeSync class. The goal is to decompose it so each concern lives in its natural package, and the monolith is deleted.

**User decisions:**

- Sigma (44k LoC): **Remove entirely**
- Supabase deployment: **New `apps/supabase` app**
- Fastify server: **Keep in source-stripe** (accept cross-package deps)
- Composition root (CLI + StripeSync): **`apps/cli`**

## Final package structure

```
packages/
  sync-protocol/              — unchanged (Layer 0, zero deps)
  source-stripe/              — gains: resource registry, webhook handler, worker, WS client
  destination-postgres/       — gains: PostgresClient, migrations, openapi
  destination-google-sheets/  — unchanged
  orchestrator-postgres/      — gains: sync metadata methods, pipeline, bridge
apps/
  cli/                        — NEW: StripeSync composition root, CLI commands, fullSync
  supabase/                   — NEW: edge function deployment, schema comments
  supabase-dashboard/         — unchanged (update import: parseSchemaComment from apps/supabase)
```

`packages/sync-engine/` is deleted.

---

## Component redistribution

### → DELETE (no new home)

| Component                | LoC     | Reason                                                           |
| ------------------------ | ------- | ---------------------------------------------------------------- |
| `sigma/`                 | ~44,775 | User decision: remove entirely                                   |
| `protocol/index.ts`      | 34      | Redundant re-export of `@tx-stripe/protocol`                     |
| `database/QueryUtils.ts` | 70      | Byte-identical duplicate of `destination-postgres/QueryUtils.ts` |

### → `packages/source-stripe`

| File                   | LoC  | Notes                                                                                                                                                        |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resourceRegistry.ts`  | ~382 | Merge with existing schemas. Exports `RESOURCE_MAP`, `buildResourceRegistry()`, `normalizeStripeObjectName()`, `getTableName()`, `getResourceConfigFromId()` |
| `stripeSyncWebhook.ts` | ~406 | Webhook signature validation, event routing, delete handling. Takes `DestinationWriter` as injected dep                                                      |
| `stripeSyncWorker.ts`  | ~315 | Parallel backfill worker. Takes `WorkerTaskManager` interface as injected dep                                                                                |
| `websocket-client.ts`  | ~382 | Stripe CLI WebSocket relay. Zero DB deps, pure source transport                                                                                              |
| `utils/hashApiKey.ts`  | ~20  | SHA256 hash for API key storage                                                                                                                              |
| Types from `types.ts`  | ~200 | `SUPPORTED_WEBHOOK_EVENTS`, `RevalidateEntity`, `StripeObject`, `SyncObjectName`, source-related types                                                       |

**Refactor `src/server/`**: Replace `@tx-stripe/sync-engine` imports with direct imports from `destination-postgres` (PostgresClient, runMigrations) and local source-stripe modules (StripeSyncWebhook, resource registry). Remove the StripeSync intermediary — server directly composes webhook handler + DB client.

### → `packages/destination-postgres`

| File                                             | LoC  | Notes                                                                                                                                                                                      |
| ------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `database/postgres.ts` (data-write methods)      | ~250 | `upsertManyWithTimestampProtection()`, `delete()`, `findMissingEntries()`, `columnExists()`, `withAdvisoryLock()`, `query()`. Merge into or alongside existing `PostgresDestinationWriter` |
| `database/migrate.ts`                            | ~741 | Migration runner + OpenAPI-driven schema generation. Remove Sigma migration code                                                                                                           |
| `database/migrations-embedded.ts`                | ~100 | Embedded SQL migration content                                                                                                                                                             |
| `database/migrations/0000_initial_migration.sql` | ~100 | Bootstrap schema DDL                                                                                                                                                                       |
| `database/migrationTemplate.ts`                  | ~50  | Template for custom migrations                                                                                                                                                             |
| `openapi/` (all files)                           | ~840 | `specParser.ts`, `postgresAdapter.ts`, `specFetchHelper.ts`, `writePathPlanner.ts`, `dialectAdapter.ts`. Generates Postgres DDL from Stripe OpenAPI specs                                  |

### → `packages/orchestrator-postgres`

| File                                           | LoC  | Notes                                                                                                                                                                                                                            |
| ---------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database/postgres.ts` (sync metadata methods) | ~250 | `upsertAccount()`, `getAccountByApiKeyHash()`, `createSyncRun()`, `closeSyncRun()`, `createObjectRuns()`, `claimNextTask()`, `updateSyncObject()`, `resetStuckRunningObjects()`, etc. Merge into existing `PostgresStateManager` |
| `pipeline.ts`                                  | ~60  | `runPipeline()` — composes Source → Destination → Orchestrator                                                                                                                                                                   |
| `sync/bridge.ts`                               | ~72  | Adapter between v1 run state and v2 Sync resources                                                                                                                                                                               |

### → `apps/cli` (NEW)

| File                                  | LoC    | Notes                                                                                                                                                |
| ------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripeSync.ts` (orchestration parts) | ~400   | `StripeSync.create()` factory, `fullSync()`, `reconciliationSync()`, `createChunks()`, `initializeSegment()`, worker management, progress monitoring |
| `cli/index.ts`                        | ~100   | Commander-based entry point                                                                                                                          |
| `cli/commands.ts`                     | ~300   | `migrate`, `sync`, `monitor`, `install`, `uninstall` commands                                                                                        |
| `cli/config.ts`                       | ~100   | Config loading from env/prompts                                                                                                                      |
| `cli/lib.ts`                          | ~100   | CLI helpers                                                                                                                                          |
| `cli/ngrok.ts`                        | ~200   | Ngrok tunnel integration                                                                                                                             |
| `version.ts`                          | ~5     | VERSION constant                                                                                                                                     |
| Application types from `types.ts`     | ~150   | `StripeSyncConfig`, `SyncResult`, `SyncParams`, etc.                                                                                                 |
| `index.ts`                            | ~60    | Re-exports public API for backward compat (`@tx-stripe/sync-engine` npm name)                                                                        |
| `tests/`                              | ~6,873 | Unit, integration, and e2e tests (move with code they test)                                                                                          |

### → `apps/supabase` (NEW)

| File                             | LoC  | Notes                                                            |
| -------------------------------- | ---- | ---------------------------------------------------------------- |
| `supabase/supabase.ts`           | ~400 | Supabase Management API client                                   |
| `supabase/lib.ts`                | ~200 | Utility functions                                                |
| `supabase/schemaComment.ts`      | ~150 | Parse/generate schema comments (also used by supabase-dashboard) |
| `supabase/edge-function-code.ts` | ~100 | Embedded edge function source strings                            |
| `supabase/edge-functions/`       | ~600 | Deno runtime: stripe-worker, stripe-webhook, stripe-setup        |

---

## Breaking circular dependencies

**Current circular path**: source-stripe/server → sync-engine → source-stripe

**Resolution**: After the refactor, source-stripe/server directly composes:

- `StripeSyncWebhook` (local, in source-stripe)
- `PostgresClient` + `runMigrations` (from destination-postgres, as optional dep)
- `resourceRegistry` (local, in source-stripe)

No StripeSync intermediary needed. No circular dependency.

**Key interfaces for dependency injection** (defined in sync-protocol):

- `DestinationWriter` — used by StripeSyncWebhook to write records
- `WorkerTaskManager` — used by StripeSyncWorker to claim/update tasks
- `Source` — used by pipeline to read records

---

## Implementation phases

### Phase 1: Create new app shells

1. Create `apps/cli/` with package.json, tsconfig
2. Create `apps/supabase/` with package.json, tsconfig
3. Update `pnpm-workspace.yaml` (already covers `apps/*`)

### Phase 2: Move self-contained modules

1. Move `supabase/` → `apps/supabase/src/`
2. Move `openapi/` → `packages/destination-postgres/src/openapi/`
3. Delete `sigma/` entirely
4. Delete `protocol/index.ts` (redundant re-export)

### Phase 3: Split PostgresClient + move migrations

1. Extract data-write methods from `database/postgres.ts` → merge into `destination-postgres`
2. Extract sync metadata methods → merge into `orchestrator-postgres/PostgresStateManager`
3. Move `migrate.ts`, `migrations-embedded.ts`, `migrations/` → `destination-postgres`
4. Remove Sigma migration code from `migrate.ts`

### Phase 4: Move source-related code to source-stripe

1. Move `resourceRegistry.ts` → `source-stripe/src/`
2. Move `stripeSyncWebhook.ts` → `source-stripe/src/`
3. Move `stripeSyncWorker.ts` → `source-stripe/src/`
4. Move `websocket-client.ts` → `source-stripe/src/`
5. Move `hashApiKey.ts` → `source-stripe/src/utils/`
6. Move source-related types from `types.ts`
7. Update `source-stripe/src/index.ts` exports

### Phase 5: Move orchestration to apps/cli

1. Move `stripeSync.ts` (composition + fullSync parts) → `apps/cli/src/`
2. Move `cli/` → `apps/cli/src/cli/`
3. Move `pipeline.ts` → `orchestrator-postgres`
4. Move `sync/bridge.ts` → `orchestrator-postgres`
5. Move application-level types
6. Set up re-exports in `apps/cli/src/index.ts` for backward compat

### Phase 6: Refactor source-stripe/server

1. Replace `StripeSync` import with direct composition (StripeSyncWebhook + PostgresClient + runMigrations)
2. Update server tests to match new imports

### Phase 7: Delete sync-engine + cleanup

1. Move remaining tests to their new homes
2. Delete `packages/sync-engine/`
3. Update all cross-repo references (Dockerfile, CI, README, AGENTS.md, contributing.md)
4. Run `pnpm install && pnpm format && pnpm lint && pnpm build`
5. Run `pnpm test -- --run` to verify

---

## Verification

1. `pnpm build` — all packages and apps build successfully
2. `pnpm test -- --run` — all unit tests pass
3. `pnpm lint && pnpm format:check` — clean
4. `packages/sync-engine/` does not exist
5. No import of `@tx-stripe/sync-engine` remains in any package (only in apps/cli's re-exports)
6. `apps/supabase-dashboard` imports `parseSchemaComment` from `@tx-stripe/integration-supabase` (or `apps/supabase`)
7. Dependency graph has no cycles: source-stripe and destination-postgres depend only on sync-protocol
