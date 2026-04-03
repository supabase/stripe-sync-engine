# Engine Interface Refactor: Per-call PipelineConfig

**PR:** #233
**Branch:** `tx/engine-interface-refactor`

## Context

`createEngine` and `createRemoteEngine` were binding `PipelineConfig` at **construction time**, making one engine instance equal one pipeline. This was the wrong granularity:

1. `/health` needs no source or destination at all
2. `/discover` needs only a source config
3. `check()` already checks source and destination independently
4. `createRemoteEngine` is just an HTTP client — forcing pipeline config at construction required callers to create a new instance per pipeline

## What Changed

### `Engine` interface

Methods now take `PipelineConfig` as the first argument. `discover()` was added, taking only source config.

```typescript
export interface Engine {
  setup(pipeline: PipelineConfig): Promise<SetupResult>
  teardown(pipeline: PipelineConfig): Promise<void>
  check(pipeline: PipelineConfig): Promise<{ source: CheckResult; destination: CheckResult }>
  discover(source: PipelineConfig['source']): Promise<CatalogMessage>
  read(
    pipeline: PipelineConfig,
    opts?: ReadOpts,
    input?: AsyncIterable<unknown>
  ): AsyncIterable<Message>
  write(
    pipeline: PipelineConfig,
    messages: AsyncIterable<Message>
  ): AsyncIterable<DestinationOutput>
  sync(
    pipeline: PipelineConfig,
    opts?: SyncOpts,
    input?: AsyncIterable<unknown>
  ): AsyncIterable<DestinationOutput>
}
```

`input` stream is always the last positional argument. `state` and `stateLimit` moved into `ReadOpts`/`SyncOpts`.

### `createEngine(resolver)` — resolver only

Config validation and catalog discovery happen per-call. `createEngineFromParams` removed.

### `createRemoteEngine(url)` — URL only

State/stateLimit moved into per-call opts.

### `activities.ts`

One `Engine` created at `createActivities()` time, reused across all activity invocations.

### `app.ts`

One `Engine` created at app startup via `createEngine(resolver)`. Each route calls `engine.method(pipeline, opts, input)`.

## Files Modified

- `apps/engine/src/lib/engine.ts`
- `apps/engine/src/lib/remote-engine.ts`
- `apps/engine/src/lib/index.ts`
- `apps/engine/src/api/app.ts`
- `apps/service/src/temporal/activities.ts`
