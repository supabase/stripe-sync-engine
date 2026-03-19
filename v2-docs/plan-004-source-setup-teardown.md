# Plan: Add `setup()` / `teardown()` to Source and Destination interfaces

## Context

Some connectors require external registration before they can produce or consume data:

| Connector          | Setup                              | Teardown                            |
| ------------------ | ---------------------------------- | ----------------------------------- |
| Stripe (webhooks)  | `stripe.webhookEndpoints.create()` | `stripe.webhookEndpoints.del()`     |
| Postgres CDC       | Create logical replication slot    | Drop replication slot               |
| Kafka source       | Subscribe to topics                | Unsubscribe / delete consumer group |
| Google Sheets dest | Create spreadsheet tabs            | (no-op)                             |
| S3 destination     | Ensure bucket/prefix exists        | (no-op)                             |

Today this logic is either buried inside `read()`/`write()` (mixing lifecycle with data flow) or handled ad-hoc outside the interface (`findOrCreateManagedWebhook()` in `stripeSyncWebhook.ts`). This makes it invisible to the orchestrator — it can't manage webhook registration, detect stale endpoints, or clean up on sync deletion.

The fix: explicit optional lifecycle hooks on the connector interfaces.

## Changes

### File: `packages/sync-protocol/src/interfaces.ts`

Add `setup()` and `teardown()` to both `Source` and `Destination`:

```ts
export interface Source<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  spec(): ConnectorSpecification
  check(params: { config: TConfig }): Promise<CheckResult>
  discover(params: { config: TConfig }): Promise<CatalogMessage>
  read(params: {
    config: TConfig
    catalog: ConfiguredCatalog
    state?: StateMessage[]
  }): AsyncIterableIterator<Message>

  /**
   * Provision external resources needed before read() can produce data.
   * Called once when a sync starts or resumes. Idempotent — safe to call
   * multiple times (e.g. after a crash recovery).
   *
   * Examples: register a webhook endpoint, create a replication slot,
   * subscribe to a topic.
   *
   * Sources that don't need setup can omit this method.
   */
  setup?(params: { config: TConfig; catalog: ConfiguredCatalog }): Promise<void>

  /**
   * Release external resources provisioned by setup().
   * Called when a sync is deleted or permanently stopped.
   *
   * Examples: delete a webhook endpoint, drop a replication slot,
   * remove a consumer group.
   *
   * Sources that don't need teardown can omit this method.
   */
  teardown?(params: { config: TConfig }): Promise<void>
}

export interface Destination<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  spec(): ConnectorSpecification
  check(params: { config: TConfig }): Promise<CheckResult>
  write(params: {
    config: TConfig
    catalog: ConfiguredCatalog
    messages: AsyncIterableIterator<DestinationInput>
  }): AsyncIterableIterator<DestinationOutput>

  /**
   * Provision external resources needed before write() can consume data.
   * Called once when a sync starts. Idempotent.
   *
   * Examples: create destination schema/tables, ensure bucket exists,
   * create spreadsheet tabs.
   *
   * Destinations that don't need setup can omit this method.
   */
  setup?(params: { config: TConfig; catalog: ConfiguredCatalog }): Promise<void>

  /**
   * Release external resources provisioned by setup().
   * Called when a sync is deleted or permanently stopped.
   *
   * Examples: drop schema (if configured), remove temp resources.
   *
   * Destinations that don't need teardown can omit this method.
   */
  teardown?(params: { config: TConfig }): Promise<void>
}
```

Both methods are **optional** (the `?` suffix). Existing connectors that don't implement them continue to work unchanged. The orchestrator checks for their existence before calling:

```ts
await source.setup?.({ config, catalog })
```

### File: `packages/sync-protocol/src/orchestrator.ts`

Update `Orchestrator.run()` contract to document lifecycle ordering:

```ts
/**
 * Run the full sync pipeline:
 *   1. source.setup()    — provision external resources (if defined)
 *   2. destination.setup() — provision external resources (if defined)
 *   3. source.discover() → build catalog
 *   4. source.read()     → forward → destination.write() → collect
 *   5. persist checkpoints
 *
 * Teardown is NOT called by run() — it's the orchestrator's responsibility
 * to call teardown() when a sync is permanently deleted, not on every run.
 */
run(source: Source, destination: Destination): Promise<StateMessage[]>
```

### No changes needed to existing connectors

- `source-stripe2` — doesn't implement `setup`/`teardown` yet (no-op, works as-is)
- `destination-postgres2` — same
- `destination-google-sheets2` — same
- `orchestrator-fs` — calls `source.setup?.()` before `read()`, no breakage if undefined

These are additive, non-breaking changes. Connectors adopt `setup`/`teardown` incrementally.

## Design decisions

### Why optional, not required?

Most sources (REST polling, file reads) and destinations (Postgres, sheets) don't need setup — they create resources lazily inside `read()`/`write()`. Making `setup`/`teardown` required would force every connector to implement no-op methods.

### Why on both Source and Destination?

Destinations may also need provisioning: creating a schema, ensuring a bucket exists, setting up permissions. Keeping the lifecycle symmetric avoids special-casing.

### Why not in `read()` / `write()`?

Separation of concerns:

- `setup()` runs **once** when a sync is activated. It's about provisioning.
- `read()` runs **continuously** (or per-backfill). It's about data flow.
- `teardown()` runs **once** when a sync is deleted. It's about cleanup.

Mixing provisioning into `read()` means: every `read()` call checks "is the webhook registered?", webhook errors get tangled with data errors, and there's no clean place to do teardown (who calls `stripe.webhookEndpoints.del()`?).

### Idempotency

`setup()` must be idempotent — the orchestrator may call it multiple times (crash recovery, process restart). For Stripe webhooks, this means `findOrCreateManagedWebhook()` (check if exists, create if not) — which is already how `stripeSyncWebhook.ts` works.

### Teardown scope

`teardown()` is called when a sync is **permanently deleted**, not when it's paused. Pausing a sync should not delete webhooks — you want events to queue up so you can resume without missing anything.

For shared resources (one webhook per account serving multiple syncs), teardown checks if any other syncs still need the resource before removing it.

## Orchestrator lifecycle (how it all fits together)

```
POST /syncs (create)
  → reconciler picks up new sync
  → source.setup({ config, catalog })     # register webhook
  → destination.setup({ config, catalog }) # create schema/tables
  → start producer + consumer

PATCH /syncs/:id { status: "paused" }
  → reconciler stops producer + consumer
  → webhook stays registered (events buffer in Stripe)
  → NO teardown

PATCH /syncs/:id { status: "syncing" }  (resume)
  → source.setup({ config, catalog })     # idempotent, verifies webhook
  → restart producer + consumer

DELETE /syncs/:id
  → stop producer + consumer
  → source.teardown({ config })           # delete webhook (if last sync for account)
  → destination.teardown({ config })      # optional cleanup
```

## Verification

This is a protocol-level change — verification is:

1. `npx tsc --noEmit -p packages/sync-protocol/tsconfig.json` — types compile
2. `pnpm build` — all downstream packages still build (non-breaking, methods are optional)
3. `pnpm test` — all existing tests pass (no connector implements them yet)
4. Manually verify: a connector WITHOUT `setup`/`teardown` still satisfies `Source`/`Destination`
