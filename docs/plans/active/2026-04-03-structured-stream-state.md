# Plan: Structured Stream State + Per-Stream Reset Signal

## Context

### Current model

`pipelineWorkflow` tracks sync progress as a single flat map:

```ts
let syncState: Record<string, unknown> = {}  // { "invoices": { cursor: "..." }, "customers": { ... } }
```

`StateStore` mirrors this — `get()` returns the full flat map; `set(stream, data)` updates one entry.
The engine's `readonlyStateStore` just seeds the map from whatever the caller passes in.

This works for REST API sources like Stripe (each stream has an independent cursor) but has two gaps:

1. **No structure** — the orchestrator has no way to distinguish a "stream cursor" from hypothetical future "global state" (e.g., a CDC log position shared across streams). When a new source type introduces a shared cursor it has no field to put it in without conflicting with stream names.
2. **No reset signal** — there is no way to tell the running workflow "forget the cursor for stream X and re-backfill it from scratch." The only workaround today is to stop the pipeline, wipe the whole state from Postgres, and restart — which resets _all_ streams.

### Airbyte protocol reference

Airbyte Protocol v2 (`AirbyteStateMessage`) distinguishes three envelope types:

| type | contents |
|------|----------|
| `STREAM` | `{ stream_descriptor, stream_state }` — independent per-stream cursor |
| `GLOBAL` | `{ shared_state, stream_states[] }` — one shared cursor (e.g. CDC LSN) plus per-stream offsets |

We don't need to copy Airbyte byte-for-byte, but the two-way distinction is the right conceptual model.

---

## Goals

1. Define typed `SyncState` / `StreamStateEntry` schemas in `protocol.ts`.
2. Replace the flat `Record<string, unknown>` bags with the typed `SyncState` throughout the workflow and activities.
3. Add a `resetStream` signal to `pipelineWorkflow` that zeroes a named stream's cursor and triggers re-backfill.

## Non-goals

- `GLOBAL` state (CDC LSN) — add the type discriminant so it's possible later, but don't implement a source that uses it yet.
- Changing the Postgres state-store schema — the `_sync_state` table already stores `(sync_id, stream, state)` rows; structured state just maps cleanly onto it.
- Altering the engine HTTP API surface — the API accepts/returns `state: Record<string, unknown>` today; we adapt internally without breaking the wire format yet.

---

## Proposed State Types

### `packages/protocol/src/protocol.ts`

```ts
/** Per-stream cursor entry (REST API sources — Stripe, etc.). */
export const StreamStateEntry = z.object({
  stream_descriptor: z.object({
    name: z.string(),
    namespace: z.string().optional(),
  }),
  stream_state: z.unknown().describe('Opaque cursor — only the source understands its contents.'),
})
export type StreamStateEntry = z.infer<typeof StreamStateEntry>

/**
 * Structured sync state envelope.
 *
 * `per_stream` — each stream has an independent cursor (REST API, webhooks).
 * `global`     — one shared cursor (CDC log offset) + per-stream offsets.
 */
export const SyncState = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('per_stream'),
    states: z.array(StreamStateEntry),
  }),
  z.object({
    type: z.literal('global'),
    shared_state: z.unknown(),
    stream_states: z.array(StreamStateEntry),
  }),
])
export type SyncState = z.infer<typeof SyncState>
```

#### Helpers (same file)

```ts
/** Extract the flat `{ [streamName]: cursor }` map the engine/source expects. */
export function toFlatState(state: SyncState): Record<string, unknown> {
  const entries = state.type === 'per_stream' ? state.states : state.stream_states
  return Object.fromEntries(entries.map((e) => [e.stream_descriptor.name, e.stream_state]))
}

/** Upsert one stream's cursor into a SyncState, returning a new SyncState. */
export function updateStreamState(state: SyncState, streamName: string, cursor: unknown): SyncState {
  const entries = state.type === 'per_stream' ? state.states : state.stream_states
  const next = upsertStream(entries, streamName, cursor)
  if (state.type === 'global') return { ...state, stream_states: next }
  return { type: 'per_stream', states: next }
}

/** Remove one stream's cursor (triggers re-backfill of that stream). */
export function resetStreamState(state: SyncState, streamName: string): SyncState {
  const entries = state.type === 'per_stream' ? state.states : state.stream_states
  const next = entries.filter((e) => e.stream_descriptor.name !== streamName)
  if (state.type === 'global') return { ...state, stream_states: next }
  return { type: 'per_stream', states: next }
}

function upsertStream(entries: StreamStateEntry[], name: string, cursor: unknown): StreamStateEntry[] {
  const idx = entries.findIndex((e) => e.stream_descriptor.name === name)
  const entry: StreamStateEntry = { stream_descriptor: { name }, stream_state: cursor }
  if (idx === -1) return [...entries, entry]
  return entries.map((e, i) => (i === idx ? entry : e))
}
```

---

## Workflow changes (`apps/service/src/temporal/workflows.ts`)

### New signal

```ts
export const resetStreamSignal = defineSignal<[string]>('reset_stream')
```

Handler (registered before any `await`):

```ts
setHandler(resetStreamSignal, (streamName: string) => {
  syncState = resetStreamState(syncState, streamName)
  readComplete = false  // force the read loop to re-check this stream
})
```

### Replace `syncState` type

```ts
// Before
let syncState: Record<string, unknown> = opts?.state ?? {}

// After
let syncState: SyncState = opts?.state ?? { type: 'per_stream', states: [] }
```

### Adapt flat-map call sites

Everywhere the workflow calls activities with `state: syncState` or merges `result.state`:

```ts
// Passing state into activity:
state: toFlatState(syncState)

// Merging result state back in:
for (const [stream, cursor] of Object.entries(result.state)) {
  syncState = updateStreamState(syncState, stream, cursor)
}
```

The `readComplete` convergence check uses `toFlatState` for the deep-equal comparison so it remains correct.

### `continueAsNew` carries typed state

```ts
await continueAsNew<typeof pipelineWorkflow>(pipeline, {
  ...opts,
  state: syncState,   // typed SyncState, not Record<string, unknown>
})
```

### `stateQuery` exposes structured state

```ts
setHandler(stateQuery, (): SyncState => syncState)
```

Update `WorkflowStatus` or export a `SyncState` query type in the service API accordingly.

### Workflow input type update

```ts
export async function pipelineWorkflow(
  pipeline: Pipeline,
  opts?: {
    phase?: string
    state?: SyncState           // was Record<string, unknown>
    mode?: 'sync' | 'read-write'
    writeRps?: number
    pendingWrites?: boolean
    inputQueue?: unknown[]
  }
): Promise<void>
```

---

## Activity changes (`apps/service/src/temporal/activities.ts`)

Activities already accept and return `state: Record<string, unknown>` from/to the engine's HTTP API — no change needed there. The workflow converts `SyncState ↔ Record<string, unknown>` via `toFlatState` / `updateStreamState` before and after each activity call.

---

## API surface: reset endpoint

A service API route for resetting a single stream:

```
POST /pipelines/:id/streams/:stream/reset
```

Handler: sends `resetStreamSignal` to the running workflow.

```ts
await handle.signal(resetStreamSignal, streamName)
```

No body needed; the signal name and the stream path param carry all the information.

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/protocol/src/protocol.ts` | Add `StreamStateEntry`, `SyncState`, and helper functions |
| `apps/service/src/temporal/workflows.ts` | Change `syncState` type, add `resetStreamSignal`, adapt merging |
| `apps/service/src/api/app.ts` (or routes file) | Add `POST /pipelines/:id/streams/:stream/reset` endpoint |
| `apps/engine/src/lib/state-store.ts` | No change needed (engine still uses flat map internally) |
| `packages/state-postgres/src/state-store.ts` | No schema change — rows already keyed by `(sync_id, stream)` |
| `./scripts/generate-openapi.sh` | Run after any route changes |

---

## Verification

```sh
# Unit tests (protocol helpers)
cd packages/protocol && pnpm test

# Service workflow tests
cd apps/service && pnpm test

# Full build
pnpm build

# Pre-push
pnpm format && pnpm lint && pnpm build
```

### Manual smoke test (reset signal)

1. Start a pipeline, let it complete a backfill of `invoices`.
2. Call `POST /pipelines/:id/streams/invoices/reset`.
3. Observe `stateQuery` shows no cursor for `invoices`.
4. Observe the workflow re-backfills `invoices` from the beginning without touching other stream cursors.

---

## Worktree

```sh
git worktree add .worktrees/structured-state -b tx/structured-state v2
```
