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

**Rationale:** Keeps connectors stateless and testable. State messages flow through the same async iterable pipeline as data, making them composable with `takeStateCheckpoints()` and other stream utilities.

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
