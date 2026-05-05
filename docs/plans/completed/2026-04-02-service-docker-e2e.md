# Service Docker E2E Test

**Date:** 2026-04-02

## Goal

Add a full-stack E2E test that builds real Docker images for the engine and
service, starts them alongside the existing compose infrastructure, and verifies
the complete Stripe → Postgres pipeline flow end-to-end.

## What gets built

| Container | Image                             | Command                                                                                |
| --------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| `engine`  | `Dockerfile` (existing)           | `node dist/cli/index.js serve`                                                         |
| `service` | `Dockerfile.service` (new)        | `sync-service serve --temporal-address temporal:7233`                                  |
| `worker`  | `Dockerfile.service` (same image) | `sync-service worker --temporal-address temporal:7233 --engine-url http://engine:3000` |

Infra containers (`temporal`, `postgres`, `stripe-mock`) are already handled by
`compose.yml` and continue to be managed there.

## New files

### `Dockerfile.service`

Same two-stage pattern as the existing `Dockerfile`:

- Stage 1: copy repo, `pnpm install --frozen-lockfile`, `pnpm --filter @stripe/sync-service deploy --prod /deploy`
- Stage 2: copy `/deploy/{package.json,dist,node_modules}` into clean `node:24-alpine`
- Entrypoint: `node dist/bin/sync-service.js`
- Default CMD: `["serve", "--temporal-address", "temporal:7233"]`
- Requires pre-built `dist/` (same constraint as existing engine `Dockerfile`)

### `compose.service.yml`

Three services that join the same project network as `compose.yml` when both
`-f` flags are passed:

```yaml
services:
  engine:
    build: { context: ., dockerfile: Dockerfile }
    ports: ['4010:3000']
    healthcheck: wget /health, interval 5s, retries 12

  service:
    build: { context: ., dockerfile: Dockerfile.service }
    ports: ['4020:4020']
    command: [serve, --temporal-address, temporal:7233, --temporal-task-queue, sync-engine]
    depends_on: { engine: healthy, temporal: healthy }
    healthcheck: wget /health, interval 5s, retries 12

  worker:
    build: { context: ., dockerfile: Dockerfile.service }
    command:
      [
        worker,
        --temporal-address,
        temporal:7233,
        --engine-url,
        'http://engine:3000',
        --temporal-task-queue,
        sync-engine,
      ]
    depends_on: { engine: healthy, temporal: healthy }
```

Note: `service` and `worker` use the same built image (no double build — compose
caches by dockerfile + context).

### `e2e/service-docker.test.ts`

**beforeAll** (timeout 5 min):

1. `pnpm build` (ensures `dist/` is fresh for Docker build context)
2. `docker compose -f compose.yml -f compose.service.yml up --build -d`
3. `pollUntil` `http://localhost:4020/health` returns 200 (timeout 2 min)
4. Open Postgres pool on `localhost:55432`

**Test: `stripe → postgres via docker containers`**:

- POST `/pipelines` to `localhost:4020` with:
  - `source`: `{ type: 'stripe', api_key: STRIPE_API_KEY }` — real Stripe
  - `destination`: `{ type: 'postgres', connection_string: 'postgresql://postgres:postgres@postgres:5432/postgres', schema: SCHEMA }`
  - `streams`: `[{ name: 'product', backfill_limit: 500 }]`
- `pollUntil` rows appear in `"SCHEMA"."product"` on `localhost:55432`
- Assert `count > 0` and `id` matches `/^prod_/`
- DELETE `/pipelines/{id}` and assert `{ deleted: true }`
- Assert GET `/pipelines/{id}` returns 404
- Assert GET `/pipelines` no longer lists the pipeline

**afterAll**:

- Drop test schema (unless `SKIP_CLEANUP=1`)
- `docker compose -f compose.yml -f compose.service.yml stop engine service worker`
- `docker compose -f compose.yml -f compose.service.yml rm -f engine service worker`
- Close Postgres pool

## Networking

Containers reach each other by compose service name. Worker calls
`http://engine:3000` for sync execution and `temporal:7233` for workflow
coordination. Source connector calls `api.stripe.com` directly (real Stripe,
no proxy needed in dev). Destination connector calls `postgres:5432` (compose
service name, port 5432 — not the host-mapped 55432).

The test runner on the host reaches:

- Service API: `localhost:4020`
- Postgres (verification): `localhost:55432`

## Running

```sh
STRIPE_API_KEY=sk_... pnpm test:e2e --reporter=verbose e2e/service-docker.test.ts
```

Or to keep containers and schema for debugging:

```sh
STRIPE_API_KEY=sk_... SKIP_CLEANUP=1 pnpm test:e2e ...
```

## Design decisions

- **`backfill_limit: 500`** on the `product` stream — caps backfill at 500
  records for test speed while still exercising real pagination.
- **Real Stripe, real Postgres** — no mocks. The worker container reaches
  `api.stripe.com` via standard outbound internet.
- **Same image for service + worker** — reduces build time; the command
  determines the role.
- **Pre-built dist/ required** — consistent with existing `Dockerfile`; the test
  runs `pnpm build` in `beforeAll` to guarantee freshness.
- **`compose.service.yml` is reusable** — other e2e tests can use
  `-f compose.yml -f compose.service.yml` to get the full stack.
