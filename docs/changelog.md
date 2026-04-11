# Changelog

> For the auto-generated release changelog, see [CHANGELOG.md](/CHANGELOG.md) in the repo root.

Completed plans and shipped features, newest first.

## 2026-04

- **Service Docker E2E** (`2026-04-02-service-docker-e2e`) — CI pipeline builds and tests service + worker Docker images; `e2e_service` job validates end-to-end behavior with stripe-mock.
- **Remote engine client** (`2026-04-01-remote-engine`) — `createRemoteEngine()` in `apps/engine` wraps all sync endpoints as a typed HTTP client; Temporal activities use it instead of calling the engine directly.
- **CodeQL fixes** (`2026-04-01-codeql-fixes`) — Resolved all CodeQL security findings in the monorepo.
- **Typed connector schemas in OpenAPI spec** — Engine `/connectors` endpoint exposes raw JSON Schema per connector; OAS 3.1 validation tests added.
- **ISO 8601 `emitted_at`** — Protocol change: `emitted_at` field changed from Unix ms integer to ISO 8601 string.

## 2026-03

- **`packages/openapi` pure utility** (`2026-03-29-openapi-pure-package-design`) — Removed transport from `packages/openapi`; fetch is now injected by callers so the package has no network dependency.
- **openapi: inject fetch** (`2026-03-29-openapi-inject-fetch`) — Removed `transport.ts` and `undici` from `packages/openapi`; callers pass a `fetch` function.
- **Stripe OpenAPI CDN** — Publish Stripe API specs to Vercel CDN at `stripe-sync.dev`.
- **Dashboard typed API clients** — Dashboard uses `openapi-fetch` for fully typed engine + service API calls.

## Earlier

- **Temporal workflow per pipeline** (`idea-001`) — Replaced the Postgres-queue orchestrator with a Temporal workflow per pipeline; each pipeline is a durable `pipelineWorkflow` with signals for pause/resume/delete/update.
- **Supabase fan-out backfill** (`plan-007`) — Rewrote Supabase backfill to fan-out via per-stream edge function invocations.
- **Source/Destination setup + teardown** (`plan-004`) — Added `setup()` / `teardown()` lifecycle hooks to the `Source` and `Destination` interfaces; Stripe connector uses them for webhook registration.
- **Remove `packages/sync-engine` monolith** (`plan-001`) — Decomposed the 61k LoC god package into focused packages; `packages/sync-engine` deleted.
- **Producer/consumer queue** (`plan-003`) — Decoupled read and write via Kafka; `readIntoQueue` + `writeFromQueue` Temporal activities replace the in-process async iterator chain.
- **One webhook → multiple syncs** — Fan-out webhook endpoint: a single Stripe webhook event is routed to all matching pipeline workflows.
- **Stateless engine HTTP API** — `apps/engine` exposes `/sync`, `/read`, `/write`, `/setup`, `/teardown`, `/discover`, `/check` as stateless HTTP endpoints.
