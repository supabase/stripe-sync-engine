# Align ControlMessage with Airbyte + Fork Sync Stream with Origin Tagging

## Context

Three problems:

1. **Naming**: Our `ControlMessage` uses `config_update` where Airbyte uses `connector_config`.

2. **Lost control messages**: During `read()`, source control messages are silently dropped by `filterType('record', 'state')` in `pipeline_write`. The Airbyte platform intercepts these mid-read. Our `setup` activity handles them for `setup()`, but `syncImmediate` does not.

3. **No origin attribution**: When `pipeline_sync` merges source and destination output, the caller can't tell which connector emitted a log or trace. The engine is stateless and should tag messages so the service can route them.

The fix: add `MessageBase` with `_emitted_by` and `_ts` envelope fields (underscore prefix = engine-injected metadata) to every protocol message, fork the read stream in `pipeline_sync` so source signals flow to the caller alongside destination output, and update the service to persist control configs.

## Changes

### 1. Protocol: MessageBase + envelope metadata + control rename

**`packages/protocol/src/protocol.ts`**

Add a `MessageBase` schema with underscore-prefixed envelope fields. The `_` prefix signals engine-injected metadata, not connector-produced data:

```ts
export const MessageBase = z.object({
  _emitted_by: z
    .string()
    .optional()
    .describe(
      'Who emitted this message: "source/{type}", "destination/{type}", or "engine". Set by the engine.'
    ),
  _ts: z
    .string()
    .datetime()
    .optional()
    .describe('ISO 8601 timestamp when the engine observed this message.'),
})
```

Format for `_emitted_by`: `source/stripe`, `destination/google-sheets`, `engine`. Slash separator is consistent with meta endpoints (`/meta/sources/{type}`) and unambiguous for connector types containing hyphens.

Then each of the 9 message schemas extends `MessageBase`:

```ts
// Example:
export const RecordMessage = MessageBase.extend({
  type: z.literal('record'),
  record: RecordPayload,
}).meta({ id: 'RecordMessage' })
```

Rename `ControlPayload.control_type`:

- `'config_update'` → `'connector_config'`

Define new `SyncOutput` union — what `pipeline_sync` yields:

```ts
export const SyncOutput = z.discriminatedUnion('type', [
  StateMessage,
  TraceMessage,
  LogMessage,
  EofMessage,
  ControlMessage,
])
```

This is `DestinationOutput | ControlMessage | LogMessage` (destination output + source signals).

**`packages/protocol/src/helpers.ts`**

- `collectControls()` line 176: `'config_update'` → `'connector_config'`

**`packages/protocol/src/index.ts`**

- Export `SyncOutput`, `MessageBase`

### 2. Connectors: rename literal

**`packages/source-stripe/src/index.ts`** line 187

- `control_type: 'config_update'` → `'connector_config'`

**`packages/destination-google-sheets/src/index.ts`** line 156

- `control_type: 'config_update'` → `'connector_config'`

### 3. Engine: fork read stream, tag origin, yield SyncOutput

**`apps/engine/src/lib/engine.ts`**

Change `Engine` interface:

```ts
pipeline_sync(...): AsyncIterable<SyncOutput>  // was DestinationOutput
```

New implementation — fork the read stream, tag origin on both branches:

```ts
async *pipeline_sync(pipeline, opts?, input?) {
  const readOutput = engine.pipeline_read(pipeline, { state: opts?.state }, input)
  const sourceSignals: Array<ControlMessage | TraceMessage | LogMessage> = []

  const sourceTag = `source/${pipeline.source.type}`
  const destTag = `destination/${pipeline.destination.type}`
  const now = () => new Date().toISOString()

  // Fork: data → destination, source signals → collected for caller
  const dataStream = (async function* () {
    for await (const msg of readOutput) {
      if (msg.type === 'record' || msg.type === 'state') {
        yield msg
      } else if (msg.type === 'control' || msg.type === 'trace' || msg.type === 'log') {
        sourceSignals.push({ ...msg, _emitted_by: sourceTag, _ts: now() } as any)
      }
    }
  })()

  // Destination receives only data, yields tagged dest output
  const writeOutput = engine.pipeline_write(pipeline, dataStream)
  const taggedWrite = (async function* () {
    for await (const msg of writeOutput) {
      yield { ...msg, _emitted_by: destTag, _ts: now() }
    }
  })()

  yield* takeLimits<SyncOutput>({
    stateLimit: opts?.stateLimit,
    timeLimit: opts?.timeLimit,
  })((async function* () {
    yield* taggedWrite
    // Source signals yielded after write completes
    for (const sig of sourceSignals) {
      if (sig.type === 'control') {
        // Validate merged config against connector spec (throws on invalid, like Message.parse)
        const connector = await resolver.resolveSource(pipeline.source.type)
        const { type: _, ...rawSrc } = pipeline.source
        await getSpecConfig(connector, { ...rawSrc, ...sig.control.config })
      }
      yield sig
    }
  })())
}
```

Note: `pipeline_write` already runs `filterType('record', 'state')` internally — but by forking here we avoid passing non-data messages through `pipeline_write` at all, which is cleaner. We can simplify `pipeline_write` later (or leave `filterType` as defense-in-depth).

Validation: `getSpecConfig` calls `spec()`, builds a Zod schema from the JSON Schema, and `.parse()`s the merged config. If invalid, it throws — same crash behavior as `Message.parse()` on bad messages. Graceful error handling (yield trace error instead) can be added later across all parse sites.

**`apps/engine/src/api/app.ts`** — `/pipeline_sync` route

- Update response schema from `DestinationOutput` to `SyncOutput`

**`apps/engine/src/lib/remote-engine.ts`**

- `pipeline_sync` return type: `AsyncIterable<SyncOutput>` (was `DestinationOutput`)

### 4. Service: collect and persist control configs in syncImmediate

**`apps/service/src/temporal/activities/_shared.ts`**

`drainMessages()` — add control collection:

```ts
const controls: Array<Record<string, unknown>> = []
// in the loop:
} else if (message.type === 'control') {
  const ctrl = message.control as Record<string, unknown>
  if (ctrl.control_type === 'connector_config') {
    controls.push(ctrl.config as Record<string, unknown>)
  }
}
// return { errors, state, records, controls, eof }
```

**`apps/service/src/temporal/activities/sync-immediate.ts`**

Persist collected controls (mirror setup.ts pattern):

```ts
const { errors, state, controls, eof } = await drainMessages(...)
if (controls.length > 0) {
  const merged = controls.reduce((acc, c) => ({ ...acc, ...c }), {})
  // _emitted_by tells us which connector — during read() it's always source
  await context.pipelines.update(pipelineId, {
    source: { ...pipeline.source, ...merged },
  })
}
return { errors, state, eof }
```

### 5. Update protocol-comparison doc

**`docs/architecture/protocol-comparison.md`**

- Update CONTROL section to reflect alignment
- Note `_emitted_by`, `_ts`, and `MessageBase` as divergences from Airbyte

## Files to modify

1. `packages/protocol/src/protocol.ts` — `MessageBase`, `_emitted_by` + `_ts` on all messages, control rename, `SyncOutput`
2. `packages/protocol/src/helpers.ts` — `collectControls` literal
3. `packages/protocol/src/index.ts` — export `SyncOutput`, `MessageBase`
4. `packages/source-stripe/src/index.ts` — `connector_config` literal
5. `packages/destination-google-sheets/src/index.ts` — `connector_config` literal
6. `apps/engine/src/lib/engine.ts` — fork read stream, tag `_emitted_by` + `_ts`, `SyncOutput` return type
7. `apps/engine/src/api/app.ts` — `/pipeline_sync` response schema
8. `apps/engine/src/lib/remote-engine.ts` — return type
9. `apps/service/src/temporal/activities/_shared.ts` — `drainMessages` collects controls
10. `apps/service/src/temporal/activities/sync-immediate.ts` — persist controls
11. `docs/architecture/protocol-comparison.md` — update comparison

## Verification

1. `pnpm build` — type-checks `MessageBase`, `_emitted_by`, `_ts`, and rename propagate everywhere
2. `pnpm test` — unit tests pass (protocol, engine, service)
3. `pnpm lint && pnpm format:check` — clean
4. Grep for `config_update` — zero hits (fully renamed)
5. Verify the OpenAPI generated types include `_emitted_by`, `_ts`, and `connector_config` (user runs `./scripts/generate-openapi.sh`)
