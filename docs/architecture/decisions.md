# Design Decision Records

Short records of key architectural choices and why they were made.

## DDR-001: `nodenext` module resolution

**Decision:** All packages use `module: "nodenext"` and `moduleResolution: "nodenext"` in tsconfig.

**Rationale:** Ensures imports match Node.js runtime behavior exactly. Requires explicit `.js` extensions in import paths, which prevents ambiguity and works with both tsc and bundlers without magic resolution.

**Consequence:** Cannot use extensionless imports. All relative imports must end in `.js` even when the source file is `.ts`.

## DDR-002: Snake_case wire format

**Decision:** All Zod schemas and JSON payloads use snake_case field names.

**Rationale:** Follows Stripe API conventions. Eliminates case-conversion bugs at serialization boundaries. TypeScript code uses camelCase internally.

**Consequence:** Zod schemas are the source of truth for field naming. TypeScript interfaces derived from Zod inherit snake_case.

## DDR-003: Message-based state flow

**Decision:** State is a message type in the protocol, not a separate storage API.

**Rationale:** Keeps connectors stateless and testable. State messages flow through the same async iterable pipeline as data, making them composable with `takeLimits()` and other stream utilities.

**Consequence:** Connectors yield `StateMessage` when they want to checkpoint. They receive state via `cursor_in` parameter, never by querying a store.

## DDR-004: Source/destination isolation

**Decision:** Source connectors never depend on destination connectors (or vice versa). Both depend only on `@stripe/sync-protocol`.

**Rationale:** Any source can be paired with any destination. Adding a new destination never requires changes to existing sources. Enforced by `e2e/layers.test.ts`.

**Consequence:** Shared logic (like retry helpers) must go in `protocol` or a shared utility package, not in a connector.

## DDR-005: NDJSON subprocess protocol

**Decision:** Connectors can run as separate processes, communicating via NDJSON over stdout.

**Rationale:** Enables language-agnostic connectors, process isolation, and independent scaling. The engine can load connectors either as in-process modules or as subprocesses.

**Consequence:** All connector output must be valid NDJSON. Debug logging must use stderr (`console.error`), never stdout.

## DDR-006: Zod for schema validation

**Decision:** Use Zod as the single schema validation library across all packages.

**Rationale:** Type inference from Zod schemas eliminates duplicate type definitions. Zod schemas can generate JSON Schema for OpenAPI docs and connector specs.

**Consequence:** `zod` is a peer dependency of `protocol`. All config validation uses Zod `parse`/`safeParse`.

## DDR-007: Half-duplex HTTP streaming for remote engine

**Decision:** `createRemoteEngine` uses `fetch` with `duplex: 'half'` for streaming endpoints (/read, /write, /sync). The full request body is sent before the response begins.

**Rationale:** True full-duplex streaming (sending request body and reading response simultaneously) requires HTTP/2 and `duplex: 'full'`, which is non-standard and not exposed by Node.js's built-in `fetch` (undici). Half-duplex is simpler and sufficient: no need to coordinate back-pressure across both directions of an HTTP connection simultaneously.

**Consequence:** Inputs to /read and /sync must be fully sent before output starts arriving. In practice all inputs are small, bounded event batches materialized as arrays by Temporal before the activity call — there is no use case for an unbounded streaming input today. If that changes, the fix is confined to `remote-engine.ts`: replace the fetch-based transport with a raw HTTP/2 client for the affected endpoints. Hono itself is transport-agnostic and would require no changes.

## DDR-008: API version discovery via config JSON Schema

**Decision:** Supported API versions are declared as a `z.enum()` on the `api_version` field of the source connector's config schema. The field is `.optional()` — when omitted, the connector defaults to the bundled version internally. Clients discover available versions by reading the `enum` from the config JSON Schema returned by `GET /meta/sources/{type}`.

**Rationale:** The config schema already flows to clients via `ConnectorSpecification.config` → `ConnectorInfo.config_schema` → `/meta/sources/{type}`. Encoding the version list directly in the field's JSON Schema (`{"enum": [...]}`) requires zero protocol changes, zero new endpoints, and zero new abstractions. The information is exactly where a client would look: in the schema for the field they're about to fill in.

**Alternatives considered:**

- _New protocol fields_ (`supported_api_versions` on `ConnectorSpecification`): Adds protocol surface for a single connector's concern.
- _New engine endpoint_ (`GET /meta/sources/{type}/api_versions` fetching CDN manifest): Dynamic but adds latency, network dependency, and a new API surface.
- _Generic metadata bag_ (`metadata: Record<string, unknown>` on `ConnectorSpecification`): Untyped, hard for clients to discover without documentation.

**Consequence:** The version list is static — updated when the connector package is released. The `SUPPORTED_API_VERSIONS` constant in `@stripe/sync-openapi` is the source of truth. Versions not in the enum are rejected at config validation time.

## DDR-009: Source-synthesised `_updated_at` for staleness gating

**Decision:** Every stream in the Stripe source catalog declares
`newer_than_field = '_updated_at'` and includes
`_updated_at: { type: 'integer' }` in `json_schema.properties`. The
source stamps every record with a unix-seconds value on that field.
Destinations project `_updated_at` from `_raw_data` as a queryable
column (e.g. Postgres timestamptz via `to_timestamp(...)`); they never
compute or rewrite the value.

The source's stamping ladder, by code path:

- **Webhook / events API / WebSocket** (`process-event.ts`):
  `dataObject.updated` if Stripe provides one, else `event.created`.
- **List-API backfill** (`src-list-api.ts`):
  `record.updated` if present, else `response.responseAt` — the HTTP `Date`
  header on the page response, which falls back to local `now()` inside
  `@stripe/sync-openapi/listFnResolver.ts` so it is never undefined.

**Rationale:** Stripe declares a native `updated` field on roughly 8 of
~100 resources. The remaining ~95% (customer, charge, invoice,
subscription, …) have no source-side staleness signal at all, so
out-of-order webhook deliveries — or a backfill page racing a live
webhook — silently overwrote newer rows with older. Synthesising one
canonical column in the source gives the whole catalog one uniform gate
that destinations can rely on without per-resource branching.

**Alternatives considered:**

- _Destination-side wall clock_ (previous behaviour): each destination
  stamped its own `_updated_at = now()`. Two destinations writing the
  same record produced different timestamps, and a re-delivered event
  always looked "newer" than the original — defeating the gate.
- _Per-stream catalog overrides_: declare `newer_than_field = 'updated'`
  on the resources that have it, leave it unset elsewhere. Loses
  protection on the long tail and forces destinations into a "no gate"
  fallback.
- _`event.created` only_: simpler, but discards the more accurate
  `record.updated` value where Stripe provides it, and offers nothing
  for backfill rows.
- _Destination-owned column not in `json_schema.properties`_: required
  the engine's `enforceCatalog` to learn an exemption for
  `newer_than_field`. Declaring `_updated_at` in the catalog as
  `{type: 'integer'}` keeps the wire contract honest and the engine's
  field filter generic.
- _`_updated_at` as a `GENERATED ALWAYS` column_: cleaner per-table model
  but breaks existing deployments — the legacy column was a non-generated
  `timestamptz NOT NULL DEFAULT now()` and Postgres requires a column
  drop+recreate to switch a non-generated column to generated. Kept the
  legacy shape and explicit write in `upsertMany` to avoid a forced
  schema migration.

**Cross-layer plumbing this requires:**

1. **Catalog declaration** (`source-stripe/src/catalog.ts`): every
   stream sets `newer_than_field = '_updated_at'` and adds
   `_updated_at: { type: 'integer' }` to `json_schema.properties` plus
   `json_schema.required`. The field is part of the wire schema, so the
   engine's `enforceCatalog` lets it through naturally without a per-field
   exemption.
2. **Postgres column shape** (`destination-postgres/src/schemaProjection.ts`):
   `_updated_at` is a hardcoded non-generated `timestamptz NOT NULL
DEFAULT now()` column at the top of every table. This shape is kept
   for backward compat: existing deployments need no column migration.
   `jsonSchemaToColumns` skips `_updated_at` so it's never also emitted
   as a generated column on top of the hardcoded one. The
   `handle_updated_at` trigger is dropped at setup; the column is now
   maintained by `upsertMany`, not by a row trigger.
3. **Postgres write**
   (`destination-postgres/src/index.ts`, `upsertMany`): the only writer of
   the column. It reads the source-stamped unix seconds at
   `record.data[newer_than_field]`, converts to ISO per row, and INSERTs
   into the `_updated_at` column. The staleness gate is hardcoded as
   `newerThanColumn: '_updated_at'` regardless of what the catalog calls
   `newer_than_field` — the source field name maps to a fixed destination
   column. Records arriving without a numeric `newer_than_field` value
   throw a loud error with a DDR-009 reference (principle #5).
4. **Sheets explicit write**
   (`destination-google-sheets/src/index.ts`): the source value is
   written into the `_updated_at` cell verbatim, and in-batch dedup
   compares it. Missing values throw with a DDR-009 reference; stale
   in-batch dupes are dropped with a debug log.

**Consequence:**

- Destinations never compute or refresh `_updated_at`; the source is the
  single writer. See principle #12.
- The legacy auto-update mechanism is removed in two places:
  `DROP TRIGGER IF EXISTS handle_updated_at` per table inside
  `buildCreateTableWithSchema`, and
  `DROP FUNCTION IF EXISTS set_updated_at() CASCADE` once at setup; the
  `CASCADE` cleans up orphan triggers from older deployments.
- The same Stripe object stamps to the same value regardless of delivery
  path (webhook re-delivery, backfill, WebSocket), so duplicates collapse
  cleanly through the gate.
- `_updated_at` is part of the published wire schema. Tools that
  consume the catalog (introspection, OpenAPI generation, custom
  destinations) see the field and can decide their own projection.

## DDR-010: JSON Schema enum enforcement in destinations

**Decision:** Any column with an `enum` array in a stream's JSON Schema gets a write-time constraint in the destination. Sources stamp the enum (e.g. `_account_id.enum: ["acct_123"]`) and destinations translate it into a native constraint — one per column.

**Rationale:** Defense-in-depth — the JSON Schema channel keeps the existing schema-projection pipeline as the only DDL writer (no parallel "catalog metadata" surface). The mechanism is generic: any enum-bearing property gets enforced, not just `_account_id`.

**Mapping:**

- **Postgres:** `ADD CONSTRAINT chk_<table>_<column> CHECK ((_raw_data->>'<column>') IS NOT NULL AND (_raw_data->>'<column>') IN (…))`, wrapped in a `DO` block with `EXCEPTION WHEN duplicate_object OR undefined_table`. The constraint validates existing rows — if any row violates it, setup fails immediately, forcing the operator to clean up bad data before proceeding. Values use standard SQL single-quote escaping.
- **Google Sheets:** `setup()` writes per-column `__enum_<column>__` marker rows to the Overview sheet; `write()` validates each record's enum-constrained columns against the read-back set.

**Mismatch is fail-loud.** `ADD CONSTRAINT` would silently no-op via `duplicate_object`, so both destinations diff the catalog enum against the existing constraint / Overview row at the top of `setup()` and throw a guiding error (naming both lists and the manual mitigation) when they differ. Same-list re-runs stay idempotent.

**Source side:** Stripe's `discover()` trusts `config.account_id` when populated (otherwise one `GET /v1/account`) and stamps `[account_id]` onto every stream via `stampAccountIdEnum`. The cache holds an account-neutral catalog.
