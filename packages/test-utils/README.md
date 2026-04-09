# @stripe/sync-test-utils

Test utilities for the sync-engine integration tests:

- **Hono HTTP server** that discovers every listable Stripe endpoint from the OpenAPI spec and serves Stripe-compatible list/retrieve responses backed by Postgres
- **Docker Postgres 18 helper** — spins up a disposable container with SSL, waits for readiness, and cleans up on exit
- **DB seeding** — generates OpenAPI-schema-compliant objects (`generateObjectsFromSchema` from `@stripe/sync-openapi`) and bulk-inserts them into Postgres with configurable `created` timestamp ranges

## Quick start

```sh
pnpm --filter @stripe/sync-test-utils build
pnpm --filter @stripe/sync-test-utils exec sync-test-utils-server
```

## Notes

- No external mock server is required. Objects are generated from OpenAPI schemas and stored directly in Postgres.
- If `POSTGRES_URL` is not provided, the server starts an internal `postgres:18` Docker container automatically.
- List query parameters are validated against each endpoint's OpenAPI parameter definitions, including v2 endpoints.
- Seeding supports spreading `created` timestamps across a range via `applyCreatedTimestampRange`.
