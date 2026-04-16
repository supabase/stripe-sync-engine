# Golden Principles

These are the non-negotiable architectural rules. Violating any of them is a bug.

## 1. Message-first protocol

All data flows as typed async iterables of messages (`RecordMessage`, `SourceStateMessage`, `CatalogMessage`, `LogMessage`). Subprocesses communicate via NDJSON over stdout/stdin.

## 2. Connector isolation

Sources never import destinations. Destinations never import sources. Both depend only on `@stripe/sync-protocol` and approved shared utilities (e.g. `@stripe/sync-util-postgres`). This is enforced by `e2e/layers.test.ts`.

## 3. State is a message

Connectors never access state storage directly. State flows in via `cursor_in` on params, and flows out as `SourceStateMessage` yielded into the stream. The engine intercepts state messages and persists them.

## 4. Snake_case on the wire

All Zod schemas and JSON wire format use **snake_case** field names. This includes connector spec schemas (`config`, `source_state_stream`, `source_input`), protocol messages, and any type whose instances are serialized to JSON. TypeScript code may use camelCase for purely internal variables and function parameters that never cross a serialization boundary.

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

## 10. Log and trace messages are liveness signals

Connectors must emit `LogMessage` or `TraceMessage` during long-running operations (at least once per table in setup, once per migration batch, periodically during reads/writes). These messages serve two purposes: human-readable progress and **liveness signals to the orchestrator**. A stream that goes silent for too long looks identical to a hang — the orchestrator (e.g. Temporal) may cancel it. Use `LogMessage` for human-readable progress, `TraceMessage` (stream_status, estimate) for structured machine-readable signals.

## 11. Stripe polymorphism pattern

Polymorphic objects use `{type, [type]: payload}` where the `type` value names the sub-hash key. This is Stripe's standard API polymorphism pattern (see Trailhead: `api-design/polymorphism-in-the-stripe-api`). Examples: `PipelineConfig.source` uses `{type: 'stripe', stripe: {...}}`, `ControlPayload` uses `{control_type: 'source_config', source_config: {...}}`, `TracePayload` uses `{trace_type: 'error', error: {...}}`.
