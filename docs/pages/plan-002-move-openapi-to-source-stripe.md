# Plan: Move openapi to source-stripe, clean Stripe refs from destination-postgres

## Context

The v2 architecture requires `destination-postgres` to be a generic Postgres destination with no Stripe-specific knowledge. Currently, both `sync-engine/src/openapi/` and an untracked copy `destination-postgres/src/openapi/` contain Stripe-specific code (OpenAPI spec fetching, resource→table mappings, DDL generation). This code belongs in `source-stripe` since it's Stripe schema knowledge.

## Changes

### 1. Move `packages/sync-engine/src/openapi/` → `packages/source-stripe/src/openapi/`

Files to move (8 source + 5 test files):

- `index.ts`, `types.ts`, `specParser.ts`, `postgresAdapter.ts`, `specFetchHelper.ts`, `dialectAdapter.ts`, `runtimeMappings.ts`, `writePathPlanner.ts`
- `__tests__/specParser.test.ts`, `__tests__/postgresAdapter.test.ts`, `__tests__/specFetchHelper.test.ts`, `__tests__/writePathPlanner.test.ts`, `__tests__/fixtures/minimalSpec.ts`

In `runtimeMappings.ts`: replace the import from `../resourceRegistry` with inlined constants (the destination-postgres copy already has this done — use that version).

Export from `packages/source-stripe/src/index.ts`.

### 2. Delete untracked `packages/destination-postgres/src/openapi/`

This was a temporary copy. Remove the entire directory.

### 3. Clean `packages/destination-postgres/src/database/migrate.ts`

- Remove `import { ... } from '../openapi'` (line 9-16)
- Remove `DEFAULT_STRIPE_API_VERSION` constant
- Remove `stripeApiVersion` from `MigrationConfig` type
- Remove `openApiSpecPath` and `openApiCacheDir` from `MigrationConfig`
- Remove `applyOpenApiSchema()` function and all its helpers: `computeOpenApiFingerprint`, `isLegacyOpenApiCommitMarker`, `listOpenApiMarkersForVersion`, `insertMigrationMarker`, `getMigrationMarkerColumn`
- Remove the `await applyOpenApiSchema(...)` call in `runMigrationsWithContent` (line 493)
- Remove `openapi:` marker filtering from applied migrations check (line 455-457) — simplify to just get all migrations
- Change default schema from `'stripe'` to `'public'` in `renameMigrationsTableIfNeeded` param and `runMigrationsWithContent`

### 4. Clean `packages/destination-postgres/src/index.ts`

Remove the entire "OpenAPI spec → DDL" export block (lines 11-23):

```
export type * from './openapi/types'
export { SpecParser, ... } from './openapi/specParser'
export { OPENAPI_COMPATIBILITY_COLUMNS } from './openapi/runtimeMappings'
export { PostgresAdapter } from './openapi/postgresAdapter'
export { WritePathPlanner } from './openapi/writePathPlanner'
export { resolveOpenApiSpec } from './openapi/specFetchHelper'
export type { DialectAdapter } from './openapi/dialectAdapter'
```

### 5. Update `packages/sync-engine/src/database/migrate.ts`

Change the openapi import from `../openapi` to `@stripe/source-stripe`:

```ts
import {
  OPENAPI_RESOURCE_TABLE_ALIASES,
  PostgresAdapter,
  RUNTIME_REQUIRED_TABLES,
  SpecParser,
  WritePathPlanner,
  resolveOpenApiSpec,
} from '@stripe/source-stripe'
```

sync-engine already depends on `@stripe/source-stripe` (package.json line 46).

### 6. Delete `packages/sync-engine/src/openapi/` directory

After confirming sync-engine's migrate.ts imports from source-stripe, delete the original openapi directory.

### 7. Update sync-engine's openapi test imports

- `packages/sync-engine/src/database/__tests__/migrate.openapi.test.ts` — change fixture import from `../../openapi/__tests__/fixtures/minimalSpec` to `@stripe/source-stripe` (or a test util)
- `packages/sync-engine/src/database/__tests__/migrate.custom-schema-name.test.ts` — same

## Verification

1. `pnpm build` — all packages compile
2. `pnpm test` in `packages/destination-postgres` — no openapi references
3. `pnpm test` in `packages/source-stripe` — openapi tests pass
4. `pnpm test` in `packages/sync-engine` — migrate tests still pass
5. `grep -r "stripe" packages/destination-postgres/src/` — only `@stripe/protocol` and schema name refs remain
