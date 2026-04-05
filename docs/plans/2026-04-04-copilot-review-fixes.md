# Pre-existing issues from Copilot review (PR #248)

These are pre-existing issues flagged by GitHub Copilot on the `better-state` PR.
They exist on the `v2` branch independently of the SyncState changes.

## CodeQL

- **`packages/ts-cli/src/openapi/parse.ts:99`** — Polynomial regex on uncontrolled data.
  Fix: rewrite the regex or add input length validation.

- **`packages/destination-google-sheets/src/index.ts:276`** — Prototype-polluting assignment.
  Fix: guard `Object.assign` target keys against `__proto__`.

## Unused imports

All pre-existing — lint doesn't catch these because they're type-only or re-exports:

- `packages/destination-google-sheets/src/index.ts` — unused `z`, `configSchema`, `GOOGLE_SHEETS_META_LOG_PREFIX`, `parseGoogleSheetsMetaLog`
- `packages/destination-postgres/src/index.ts` — unused `z`, `configSchema`
- `packages/source-stripe/src/index.ts` — unused `z`, `configSchema`
- `apps/service/src/temporal/activities/write-google-sheets-from-queue.ts` — unused `serializeRowKey`

## Supabase edge functions

- **`apps/supabase/src/edge-functions/deno.json:6`** — import map defines `pg` but `stripe-sync.ts` uses explicit `npm:pg@8` specifier. Standardize on one approach.
- **`apps/supabase/src/supabase.ts:95`** — JSDoc says default interval is 60s but implementation is 30s.

## Dashboard

- **`apps/dashboard/e2e/global-setup.ts:17`** — `createConnectorResolver()` and `createApp()` may need `await`.
- **`apps/dashboard/src/lib/api.ts:47`** — NDJSON response read into memory via `response.text()` instead of streaming.

## Docker

- **`Dockerfile:14`** — manifests stage `COPY . .` invalidates layer cache on any source change.

## Engine

- **`apps/engine/src/lib/remote-engine.ts:61`** — `Object.keys(opts.state).length` check is always 2 with `SyncState`. Consider checking `streams`/`global` emptiness instead.
- **`apps/engine/src/lib/source-exec.ts:54`** — Subprocess source wrapper types `state` as flat `Record<string, unknown>`. Should pass `SyncState` and let the subprocess handle it via NDJSON.
