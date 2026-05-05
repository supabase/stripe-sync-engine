# Reverse ETL MVP

## Context

Sync engine usually moves Stripe data out:

```text
source-stripe -> sync engine -> destination-postgres
```

This branch proves the reverse direction using the same connector model:

```text
source-postgres -> sync engine -> destination-stripe -> Stripe Custom Objects
```

The MVP is deliberately narrow. It reads rows from one Postgres table or query and writes append-only records into a configured Stripe Custom Object. It does not try to become a generic reverse ETL platform, a Customer upsert tool, or a transformation DSL.

## Current Shape

`source-postgres` reads a deterministic incremental stream:

- Connects to Postgres using `url` or `connection_string`.
- Reads either a `table` or a `query`.
- Requires `primary_key` and `cursor_field`.
- Discovers a catalog stream with `primary_key` and `newer_than_field`.
- Pages by `(cursor_field, primary_key)`.
- Emits `source_state` after page boundaries.

`destination-stripe` writes Stripe Custom Objects only:

- Requires `object: "custom_object"`.
- Requires `api_version: "unsafe-development"`.
- Requires `write_mode: "create"`.
- Requires per-stream config under `streams`.
- Maps source fields into `fields` for `POST /v2/extend/objects/{plural_name}`.
- Uses JSON request bodies for Stripe v2 Custom Object creates.
- Uses stable idempotency keys that include stream, operation, primary key, and `newer_than_field` value.

The engine stays generic. It discovers the source catalog, applies selected fields, pipes records and state into the destination, and persists only the `source_state` messages the destination re-emits.

## Example Pipeline

```json
{
  "source": {
    "type": "postgres",
    "postgres": {
      "url": "postgres://...",
      "table": "devices",
      "primary_key": ["id"],
      "cursor_field": "updated_at",
      "page_size": 100
    }
  },
  "destination": {
    "type": "stripe",
    "stripe": {
      "api_key": "sk_test_...",
      "api_version": "unsafe-development",
      "object": "custom_object",
      "write_mode": "create",
      "streams": {
        "devices": {
          "plural_name": "matcha_objects",
          "field_mapping": {
            "name": "name",
            "time_from_harvest": "time_from_harvest"
          }
        }
      }
    }
  },
  "streams": [{ "name": "devices", "sync_mode": "incremental" }]
}
```

## Goals

- Prove reverse ETL fits normal connector composition.
- Keep source and destination isolated behind `@stripe/sync-protocol`.
- Add a small Postgres source that can read one table or query incrementally.
- Add a small Stripe destination for append-only Custom Object creates.
- Make checkpoint safety explicit: source cursors advance only after destination writes succeed.
- Keep config validation strict and consistent through the engine/service JSON Schema path.

## Non-Goals

- No Customer upsert support in this MVP.
- No generic Stripe object writer.
- No update/delete behavior for Custom Objects.
- No mapping UI.
- No generic transformation DSL.
- No destination-owned mapping state.
- No CDC/logical replication.
- No dead-letter queue or per-record recovery workflow.

## Config Validation

The Stripe destination config schema is intentionally strict. Legacy Custom Object shorthand keys are rejected instead of ignored:

- `plural_name`
- `field_mapping`
- `stripe_record_id_field`
- `auto_map_fields`

Those keys are only valid inside `streams[stream_name]`, where each stream names the Custom Object plural name and field mapping.

The schema avoids merge-critical `superRefine()` rules because the engine and service validate connector configs from JSON Schema with `z.fromJSONSchema()`. Rules that must hold on API/engine paths are encoded structurally:

- `object` is a literal `custom_object`.
- `api_version` is a literal `unsafe-development`.
- `write_mode` is a literal `create`.
- Unknown top-level keys are rejected.
- Unknown per-stream keys are rejected.
- `streams` is required.

Runtime guards still fail closed before writes. They are a backstop, not the primary user-facing validation path.

## Checkpoint Contract

The destination is the commit gate.

`source-postgres` can emit records and `source_state`, but the engine only persists states returned by `destination-stripe`. This lets the destination withhold checkpoints when Stripe writes fail.

Rules:

- After a successful record write, the destination re-emits the record.
- After successful prior writes, the destination re-emits stream `source_state`.
- If any stream write fails, state for that stream is withheld.
- If any stream write fails, global source state is withheld.
- If destination setup/config/OpenAPI validation fails before records, all source state is withheld.
- Setup failure emits failed connection/stream status so the run fails instead of silently advancing.

This keeps checkpoint safety local to the destination, where write durability is known. The engine does not special-case Stripe.

## Field Selection And Idempotency

`applySelection()` preserves both primary key fields and `newer_than_field` when pruning selected fields.

That matters for reverse ETL. `destination-stripe` includes the `newer_than_field` value in the idempotency key. If field selection removed the cursor field from the record payload, two updates to the same source row could generate the same Stripe idempotency key and be treated as a replay instead of a distinct append-only Custom Object create.

## Failure Behavior

| Case                                 | Behavior                                                                |
| ------------------------------------ | ----------------------------------------------------------------------- |
| Legacy config key                    | Reject config through direct Zod and JSON Schema round-trip validation. |
| Customer config key                  | Reject config. Customer writes are not part of this MVP.                |
| Missing Custom Object definition     | Fail setup/check. Do not advance checkpoints.                           |
| Unknown mapped Custom Object field   | Fail setup/check. Do not advance checkpoints.                           |
| Stripe 400 write error               | Mark stream errored. Withhold stream and global state.                  |
| Stripe 429/5xx/network error         | Retry with backoff and stable idempotency key.                          |
| State-only input after setup failure | Emit failure status and withhold stream/global state.                   |
| No rows after resume                 | Emit no records and create no Stripe objects.                           |

## Why This Fits

The connector model already has the right shape:

- Sources own source cursors.
- Destinations own write durability.
- The engine wires streams together.
- Connector-specific behavior stays inside the connector.

This branch does not add a new engine mode. Reverse ETL is just another source/destination pairing:

```text
source-postgres -> destination-stripe
```

The important extension is behavioral, not architectural: destinations must be careful about when they pass through `source_state`.

## Validation Run

The branch was validated with:

- `pnpm --filter @stripe/sync-destination-stripe build`
- `pnpm --filter @stripe/sync-engine build`
- `NODE_OPTIONS='--conditions=bun' pnpm --filter @stripe/sync-destination-stripe exec vitest run src/index.test.ts`
- `NODE_OPTIONS='--conditions=bun' pnpm --filter @stripe/sync-engine exec vitest run src/lib/destination-filter.test.ts src/lib/reverse-etl.test.ts`
- `./scripts/generate-openapi.sh`
- `pnpm lint`
- `git diff --check`

Live validation used Docker Postgres and real Stripe Custom Objects:

- Seeded a `devices` table in Docker Postgres.
- Synced one row into live Stripe `matcha_objects`.
- Resumed with no source changes and verified no new Stripe object was created.
- Updated the same source row with a newer cursor and verified a distinct second Custom Object was created.
- Verified fields and cursors.
- Deleted all live test objects and verified zero leftovers.

## Follow-Ups

- Decide whether Customer upserts should be a separate destination mode or a separate future plan.
- Decide whether destination-owned mapping state is needed before supporting update semantics.
- Add durable docs/examples once the Custom Object API shape is stable.
- Consider a reusable live reverse ETL e2e test harness if this path becomes a supported product surface.
