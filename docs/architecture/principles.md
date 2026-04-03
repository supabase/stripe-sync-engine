# Golden Principles

These are the non-negotiable architectural rules. Violating any of them is a bug.

## 1. Message-first protocol

All data flows as typed async iterables of messages (`RecordMessage`, `StateMessage`, `CatalogMessage`, `LogMessage`). Subprocesses communicate via NDJSON over stdout/stdin.

## 2. Connector isolation

Sources never import destinations. Destinations never import sources. Both depend only on `@stripe/sync-protocol` and approved shared utilities (e.g. `@stripe/sync-util-postgres`). This is enforced by `e2e/layers.test.ts`.

## 3. State is a message

Connectors never access state storage directly. State flows in via `cursor_in` on params, and flows out as `StateMessage` yielded into the stream. `StatefulSync` intercepts state messages and persists them.

## 4. Snake_case on the wire

All Zod schemas and JSON wire format use **snake_case** field names. TypeScript code uses camelCase internally, but serialization boundaries are always snake_case.

## 5. api_version is required

Stripe API version is always a mandatory field in source config schemas. Never optional.

## 6. Shared utilities over hand-rolled helpers

Use `util-postgres` for upsert and rate limiting, `state-postgres` for migrations. Don't reinvent these in connectors.

## 7. Tests fail loud

No silent skips when dependencies (stripe-mock, Docker Postgres) are unavailable. Tests must fail hard so broken infrastructure is visible.

## 8. Schema is discovered, not hardcoded

Sources advertise available streams via `CatalogMessage`. Destinations create tables from the catalog. No hardcoded table definitions.

## 9. Use `.describe()` for Zod field descriptions

JSDoc comments on Zod fields (`/** ... */`) are stripped by TypeScript and never reach the OpenAPI generator. Always use `.describe('...')` on Zod schema fields so descriptions appear in the generated spec.
