# Better-Typed State: SyncState = { streams, global }

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `Record<string, unknown>` state with a typed `SyncState = { streams, global }` shape aligned with Airbyte's `state_type: STREAM | GLOBAL` discriminator.

**Architecture:** Add `SyncState` Zod schema + type to protocol; replace `StatePayload` with a discriminated union (`StreamStatePayload | GlobalStatePayload`); thread `SyncState` through engine `StateStore`, `SourceReadOptions`, `app.ts` X-State header, postgres state store, and service workflows/activities. Source-stripe gets minimal type-level updates (per-stream access `state.streams[name]` instead of `state[name]`). Global state _usage_ (moving `events_cursor`) is a follow-up PR.

**Tech Stack:** TypeScript, Zod 4, Temporal, Postgres, pnpm monorepo

---

## Files modified

| File                                                                | Change                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/protocol/src/protocol.ts`                                 | Add `SyncState`, discriminated `StatePayload`, update `SyncParams`, `Source.read()` |
| `apps/engine/src/lib/state-store.ts`                                | Add `setGlobal`, update `get()` → `SyncState`                                       |
| `apps/engine/src/lib/pipeline.ts`                                   | `enforceCatalog` passes global state; `persistState` routes to `setGlobal`          |
| `apps/engine/src/lib/engine.ts`                                     | `SourceReadOptions.state` → `SyncState`; pass `state.streams` to connector          |
| `apps/engine/src/api/app.ts`                                        | `xStateHeader` accepts `SyncState` with old-format backward compat                  |
| `packages/state-postgres/src/state-store.ts`                        | `_global` reserved row, `setGlobal()`, `get()` → `SyncState`                        |
| `apps/service/src/temporal/workflows/_shared.ts`                    | `stateQuery` → `SyncState`                                                          |
| `apps/service/src/temporal/workflows/pipeline-workflow.ts`          | `syncState: SyncState`, new merge                                                   |
| `apps/service/src/temporal/workflows/backfill-pipeline-workflow.ts` | Same                                                                                |
| `apps/service/src/temporal/activities/_shared.ts`                   | `RunResult.state → SyncState`, `drainMessages` accumulates `SyncState`              |
| `packages/source-stripe/src/src-list-api.ts`                        | `state?.[name]` → `state?.streams[name]`                                            |
| `packages/source-stripe/src/src-events-api.ts`                      | Same + update `state` param type                                                    |
| `packages/source-stripe/src/index.ts`                               | `read()` params type: `state?: SyncState`                                           |
| `docs/architecture/protocol-comparison.md`                          | Update STATE table; remove gap #2                                                   |

---

## Task 1: Protocol — SyncState + discriminated StatePayload

### Files

- Modify: `packages/protocol/src/protocol.ts`
- Create: `packages/protocol/src/__tests__/state.test.ts`

### Step 1: Write failing tests

```ts
// packages/protocol/src/__tests__/state.test.ts
import { describe, it, expect } from 'vitest'
import { SyncState, StatePayload, StreamStatePayload, GlobalStatePayload } from '../protocol.js'

describe('SyncState', () => {
  it('parses a full SyncState', () => {
    expect(SyncState.parse({ streams: { orders: { cursor: 1 } }, global: {} })).toEqual({
      streams: { orders: { cursor: 1 } },
      global: {},
    })
  })
  it('requires both fields', () => {
    expect(() => SyncState.parse({ streams: {} })).toThrow()
  })
})

describe('StatePayload backward compat', () => {
  it('parses old format (no state_type) as stream', () => {
    const result = StatePayload.parse({ stream: 'orders', data: { cursor: 1 } })
    expect(result.state_type).toBe('stream')
    if (result.state_type === 'stream') {
      expect(result.stream).toBe('orders')
      expect(result.data).toEqual({ cursor: 1 })
    }
  })
})

describe('StreamStatePayload', () => {
  it('parses explicit stream state', () => {
    const result = StreamStatePayload.parse({ state_type: 'stream', stream: 'orders', data: {} })
    expect(result.state_type).toBe('stream')
  })
})

describe('GlobalStatePayload', () => {
  it('parses global state', () => {
    const result = GlobalStatePayload.parse({
      state_type: 'global',
      data: { events_cursor: 'evt_1' },
    })
    expect(result.state_type).toBe('global')
    expect(result.data).toEqual({ events_cursor: 'evt_1' })
  })
})
```

### Step 2: Run to verify failure

```bash
pnpm --filter @stripe/sync-protocol test --reporter=verbose
```

Expected: FAIL — `SyncState`, `StreamStatePayload`, `GlobalStatePayload` not found.

### Step 3: Implement in protocol.ts

**a) Add `SyncState` (after the `SyncParams` import block — before "MARK: - Data model"):**

```ts
// Aggregate state shape — replaces Record<string, unknown> everywhere
export const SyncState = z.object({
  streams: z.record(z.string(), z.unknown()),
  global: z.record(z.string(), z.unknown()),
})
export type SyncState = z.infer<typeof SyncState>
```

**b) Replace `StatePayload` (currently lines 128–138) with:**

```ts
export const StreamStatePayload = z
  .object({
    state_type: z.literal('stream').default('stream'),
    stream: z.string().describe('Stream being checkpointed.'),
    data: z
      .unknown()
      .describe('Opaque checkpoint data — only the source understands its contents.'),
  })
  .describe('Per-stream checkpoint for resumable syncs.')
export type StreamStatePayload = z.infer<typeof StreamStatePayload>

export const GlobalStatePayload = z
  .object({
    state_type: z.literal('global'),
    data: z
      .unknown()
      .describe('Sync-wide state shared across all streams (e.g. a global events cursor).'),
  })
  .describe('Sync-wide checkpoint shared across all streams.')
export type GlobalStatePayload = z.infer<typeof GlobalStatePayload>

// Use z.preprocess to inject state_type: 'stream' for old messages that lack the field.
// This provides backward compat: { stream, data } → { state_type: 'stream', stream, data }.
export const StatePayload = z.preprocess(
  (input) => {
    if (typeof input === 'object' && input !== null && !('state_type' in input)) {
      return { ...input, state_type: 'stream' }
    }
    return input
  },
  z.discriminatedUnion('state_type', [StreamStatePayload, GlobalStatePayload])
) as unknown as z.ZodType<StreamStatePayload | GlobalStatePayload>
export type StatePayload = z.infer<typeof StatePayload>
```

**c) Update `ConnectorSpecification.stream_state` description to mention global state:**

Change the description to:

```ts
stream_state: z
  .record(z.string(), z.unknown())
  .optional()
  .describe('JSON Schema for per-stream state (cursor/checkpoint shape). See also SyncState.global for sync-wide cursors.'),
```

**d) Update `SyncParams` interface** (replace `state?: Record<string, unknown>` with):

```ts
export interface SyncParams {
  pipeline: PipelineConfig
  state?: SyncState
  state_limit?: number
  time_limit?: number
}
```

**e) Update `Source.read()` params** — change `state?: Record<string, TStreamState>` to `state?: SyncState`:

```ts
read(
  params: {
    config: TConfig
    catalog: ConfiguredCatalog
    state?: SyncState
  },
  $stdin?: AsyncIterable<TInput>
): AsyncIterable<Message>
```

### Step 4: Run tests to verify pass

```bash
pnpm --filter @stripe/sync-protocol test --reporter=verbose
```

Expected: All PASS.

### Step 5: Commit

```bash
git add packages/protocol/src/protocol.ts packages/protocol/src/__tests__/state.test.ts
git commit -m "feat(protocol): add SyncState + discriminated StatePayload (stream | global)"
```

---

## Task 2: Engine StateStore — add setGlobal, update get() return type

### Files

- Modify: `apps/engine/src/lib/state-store.ts`

### Step 1: Write failing test

Add to `apps/engine/src/lib/engine.test.ts` or a new `apps/engine/src/lib/state-store.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { readonlyStateStore } from './state-store.js'
import type { SyncState } from '@stripe/sync-protocol'

describe('readonlyStateStore', () => {
  it('returns undefined when no state provided', async () => {
    const store = readonlyStateStore()
    expect(await store.get()).toBeUndefined()
  })

  it('returns provided SyncState unchanged', async () => {
    const state: SyncState = {
      streams: { orders: { cursor: 1 } },
      global: { events_cursor: 'evt_1' },
    }
    const store = readonlyStateStore(state)
    expect(await store.get()).toEqual(state)
  })

  it('no-ops on set()', async () => {
    const store = readonlyStateStore()
    await expect(store.set('orders', {})).resolves.toBeUndefined()
  })

  it('no-ops on setGlobal()', async () => {
    const store = readonlyStateStore()
    await expect(store.setGlobal({})).resolves.toBeUndefined()
  })
})
```

### Step 2: Run to verify failure

```bash
pnpm --filter @stripe/sync-engine test --reporter=verbose 2>&1 | grep -A5 "readonlyStateStore"
```

### Step 3: Implement

Replace the entire `apps/engine/src/lib/state-store.ts` with:

```ts
import type { SyncState } from '@stripe/sync-protocol'

// MARK: - Interface

/** Pipeline-scoped state store — load prior state and persist checkpoints. */
export interface StateStore {
  get(): Promise<SyncState | undefined>
  set(stream: string, data: unknown): Promise<void>
  setGlobal(data: unknown): Promise<void>
}

// MARK: - Read-only state store

/**
 * A StateStore that returns the provided initial state (if any) and discards all writes.
 * Use when the caller manages state externally (e.g., via HTTP headers or workflow state).
 */
export function readonlyStateStore(state?: SyncState): StateStore {
  return {
    async get() {
      return state
    },
    async set() {},
    async setGlobal() {},
  }
}
```

### Step 4: Run tests

```bash
pnpm --filter @stripe/sync-engine test --reporter=verbose 2>&1 | grep -A5 "readonlyStateStore"
```

### Step 5: Commit

```bash
git add apps/engine/src/lib/state-store.ts
git commit -m "feat(engine): update StateStore interface — get() → SyncState, add setGlobal()"
```

---

## Task 3: Engine pipeline.ts — enforceCatalog + persistState

### Files

- Modify: `apps/engine/src/lib/pipeline.ts`
- Modify: `apps/engine/src/lib/pipeline.test.ts` (add tests)

### Step 1: Write failing tests

Find `apps/engine/src/lib/pipeline.test.ts` and add to the `persistState` describe block:

```ts
// In the persistState describe block:
it('calls setGlobal for global state messages', async () => {
  const store = {
    get: vi.fn(),
    set: vi.fn(),
    setGlobal: vi.fn().mockResolvedValue(undefined),
  }
  const msg: DestinationOutput = {
    type: 'state',
    state: { state_type: 'global', data: { events_cursor: 'evt_123' } },
  }
  const output = persistState(store)(asIterable([msg]))
  for await (const _ of output) {
    /* drain */
  }
  expect(store.setGlobal).toHaveBeenCalledWith({ events_cursor: 'evt_123' })
  expect(store.set).not.toHaveBeenCalled()
})

it('calls set for stream state messages', async () => {
  const store = {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
    setGlobal: vi.fn(),
  }
  const msg: DestinationOutput = {
    type: 'state',
    state: { state_type: 'stream', stream: 'orders', data: { cursor: 1 } },
  }
  const output = persistState(store)(asIterable([msg]))
  for await (const _ of output) {
    /* drain */
  }
  expect(store.set).toHaveBeenCalledWith('orders', { cursor: 1 })
  expect(store.setGlobal).not.toHaveBeenCalled()
})
```

Add to the `enforceCatalog` describe block:

```ts
it('passes global state messages through without catalog validation', async () => {
  const catalog: ConfiguredCatalog = { streams: [] } // empty — no streams in catalog
  const msg: Message = {
    type: 'state',
    state: { state_type: 'global', data: { events_cursor: 'evt_1' } },
  }
  const out = await collect(enforceCatalog(catalog)(asIterable([msg])))
  expect(out).toHaveLength(1)
  expect(out[0]).toMatchObject({ type: 'state', state: { state_type: 'global' } })
})
```

### Step 2: Run to verify failure

```bash
pnpm --filter @stripe/sync-engine test --reporter=verbose 2>&1 | grep -E "FAIL|persistState|enforceCatalog" | head -20
```

### Step 3: Implement

In `pipeline.ts`, update `persistState` (lines 98–107):

```ts
export function persistState(
  store: StateStore
): (msgs: AsyncIterable<DestinationOutput>) => AsyncIterable<DestinationOutput> {
  return async function* (messages) {
    for await (const msg of messages) {
      if (msg.type === 'state') {
        if (msg.state.state_type === 'global') {
          await store.setGlobal(msg.state.data)
        } else {
          await store.set(msg.state.stream, msg.state.data)
        }
      }
      yield msg
    }
  }
}
```

In `enforceCatalog` (lines 37–43), update the state branch:

```ts
} else if (msg.type === 'state') {
  if (msg.state.state_type === 'global') {
    yield msg  // global state needs no catalog validation
  } else {
    const cs = streamMap.get(msg.state.stream)
    if (!cs) {
      logger.error({ stream: msg.state.stream }, 'Unknown stream not in catalog')
      continue
    }
    yield msg
  }
}
```

### Step 4: Run tests

```bash
pnpm --filter @stripe/sync-engine test --reporter=verbose
```

Expected: All PASS.

### Step 5: Commit

```bash
git add apps/engine/src/lib/pipeline.ts apps/engine/src/lib/pipeline.test.ts
git commit -m "feat(engine): route global/stream state in persistState; pass global through enforceCatalog"
```

---

## Task 4: Engine engine.ts — SourceReadOptions.state → SyncState

### Files

- Modify: `apps/engine/src/lib/engine.ts`

### Step 1: Update `SourceReadOptions`

Change line 31:

```ts
// Before:
state: z.record(z.string(), z.unknown()).optional(),
// After:
state: SyncState.optional(),
```

Add the `SyncState` import at the top (add to the existing `@stripe/sync-protocol` import):

```ts
import {
  // ... existing imports ...
  SyncState,
} from '@stripe/sync-protocol'
```

### Step 2: Update `pipeline_read` handler to pass `state.streams` to the connector

The connector's `read()` now expects `state?: SyncState`. In the `pipeline_read` method (around line 391):

```ts
// Before:
const state = opts?.state
const raw = connector.read({ config: sourceConfig, catalog, state }, input)

// After:
const state = opts?.state
const raw = connector.read({ config: sourceConfig, catalog, state }, input)
```

No change needed here — the connector receives the full `SyncState` (including `global`). Source connectors that previously accessed `state?.[name]` now access `state?.streams[name]` (updated in Task 8).

### Step 3: Verify build

```bash
pnpm --filter @stripe/sync-engine build 2>&1 | tail -10
```

### Step 4: Commit

```bash
git add apps/engine/src/lib/engine.ts
git commit -m "feat(engine): SourceReadOptions.state → SyncState"
```

---

## Task 5: Engine app.ts — xStateHeader with backward compat

### Files

- Modify: `apps/engine/src/api/app.ts`

### Step 1: Update imports

Add `SyncState` to the `@stripe/sync-protocol` import block.

### Step 2: Replace `xStateHeader`

The current `xStateHeader` (lines 135–143) parses a flat `Record<string, unknown>`. Replace with:

```ts
const xStateHeader = z
  .string()
  .transform(jsonParse)
  .pipe(
    // Accept both new format { streams, global } and old flat format { stream_name: data, ... }.
    // Old format: any JSON object that lacks a 'streams' key — wrap it as { streams: <obj>, global: {} }.
    z.union([
      SyncState,
      z
        .record(z.string(), z.unknown())
        .transform((flat): SyncState => ({ streams: flat, global: {} })),
    ])
  )
  .optional()
  .meta({
    description: 'JSON-encoded SyncState ({ streams, global }) or legacy flat per-stream state',
    param: { content: { 'application/json': {} } },
  })
```

### Step 3: Update handler casts

Find the two places where `c.req.valid('header')['x-state']` is cast:

```ts
// In pipelineReadRoute handler (around line 311):
// Before: const state = c.req.valid('header')['x-state'] as Record<string, unknown> | undefined
// After:
const state = c.req.valid('header')['x-state'] // already SyncState | undefined after header parse

// In pipelineSyncRoute handler (around line 407):
// Before: const state = c.req.valid('header')['x-state'] as Record<string, unknown> | undefined
// After:
const state = c.req.valid('header')['x-state']
```

### Step 4: Verify build

```bash
pnpm --filter @stripe/sync-engine build 2>&1 | tail -10
```

If `RouteInput` type errors appear, they are pre-existing — run `git diff HEAD -- apps/engine/src/api/app.ts` to confirm.

### Step 5: Commit

```bash
git add apps/engine/src/api/app.ts
git commit -m "feat(engine): X-State header accepts SyncState with old-format backward compat"
```

---

## Task 6: Postgres state store — \_global row + setGlobal

### Files

- Modify: `packages/state-postgres/src/state-store.ts`

### Step 1: Write failing integration test

Add `packages/state-postgres/src/__tests__/state-store.test.ts` (skip if no local Postgres — `it.skipIf(!process.env.DATABASE_URL)`):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import pg from 'pg'
import { createPgStateStore, setupStateStore } from '../state-store.js'

const CONN = process.env.DATABASE_URL ?? 'postgres://localhost/test'
const SKIP = !process.env.DATABASE_URL

describe.skipIf(SKIP)('createPgStateStore global state', () => {
  let pool: pg.Pool

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: CONN })
    await setupStateStore({ connection_string: CONN })
    await pool.query(`DELETE FROM public._sync_state WHERE sync_id = 'test-global'`)
  })

  it('setGlobal writes _global row and get() returns it under global key', async () => {
    const store = createPgStateStore(pool, 'public')
    await store.setGlobal('test-global', { events_cursor: 'evt_abc' })
    const state = await store.get('test-global')
    expect(state).toBeDefined()
    expect(state!.global).toEqual({ events_cursor: 'evt_abc' })
    expect(state!.streams).toEqual({})
  })

  it('set() writes per-stream rows and get() returns them under streams key', async () => {
    const store = createPgStateStore(pool, 'public')
    await store.set('test-global', 'orders', { cursor: 5 })
    const state = await store.get('test-global')
    expect(state!.streams).toEqual({ orders: { cursor: 5 } })
    expect(state!.global).toEqual({})
  })

  it('get() reconstructs SyncState from a mix of stream and _global rows', async () => {
    const store = createPgStateStore(pool, 'public')
    await store.set('test-global', 'orders', { cursor: 5 })
    await store.setGlobal('test-global', { events_cursor: 'evt_abc' })
    const state = await store.get('test-global')
    expect(state!.streams).toEqual({ orders: { cursor: 5 } })
    expect(state!.global).toEqual({ events_cursor: 'evt_abc' })
  })

  afterEach(() => pool.end())
})
```

### Step 2: Run to verify failure

```bash
pnpm --filter @stripe/sync-state-postgres test --reporter=verbose
```

### Step 3: Implement

**a) Add `SyncState` import** at top of the file:

```ts
import type { SyncState } from '@stripe/sync-protocol'
```

**b) Update `StateStore` interface** (lines 9–13):

```ts
export interface StateStore {
  get(syncId: string): Promise<SyncState | undefined>
  set(syncId: string, stream: string, data: unknown): Promise<void>
  setGlobal(syncId: string, data: unknown): Promise<void>
  clear(syncId: string): Promise<void>
}
```

**c) Update `createPgStateStore.get()`** to reconstruct `SyncState`:

```ts
async get(syncId: string): Promise<SyncState | undefined> {
  const { rows } = await pool.query<{ stream: string; state: unknown }>(
    sql`SELECT stream, state FROM "${schema}"."_sync_state" WHERE sync_id = $1`,
    [syncId]
  )
  if (rows.length === 0) return undefined
  const streams: Record<string, unknown> = {}
  let global: Record<string, unknown> = {}
  for (const row of rows) {
    if (row.stream === '_global') {
      global = row.state as Record<string, unknown>
    } else {
      streams[row.stream] = row.state
    }
  }
  return { streams, global }
},
```

**d) Add `setGlobal()` to `createPgStateStore`**:

```ts
async setGlobal(syncId: string, data: unknown) {
  await pool.query(
    sql`INSERT INTO "${schema}"."_sync_state" (sync_id, stream, state, updated_at)
     VALUES ($1, '_global', $2, NOW())
     ON CONFLICT (sync_id, stream) DO UPDATE SET state = $2, updated_at = NOW()`,
    [syncId, JSON.stringify(data)]
  )
},
```

**e) Update `ScopedStateStore` interface** (lines 59–62):

```ts
export interface ScopedStateStore {
  get(): Promise<SyncState | undefined>
  set(stream: string, data: unknown): Promise<void>
  setGlobal(data: unknown): Promise<void>
}
```

**f) Update `createScopedPgStateStore`** to add `setGlobal`:

```ts
return {
  get: () => store.get(syncId),
  set: (stream, data) => store.set(syncId, stream, data),
  setGlobal: (data) => store.setGlobal(syncId, data),
}
```

**g) Update `createStateStore`** — the spread `...scoped` picks up `setGlobal` automatically.

### Step 4: Run tests

```bash
pnpm --filter @stripe/sync-state-postgres test --reporter=verbose
```

### Step 5: Commit

```bash
git add packages/state-postgres/src/state-store.ts packages/state-postgres/src/__tests__/state-store.test.ts
git commit -m "feat(state-postgres): _global reserved row + setGlobal(); get() returns SyncState"
```

---

## Task 7: Service layer — workflows + activities

### Files

- Modify: `apps/service/src/temporal/workflows/_shared.ts`
- Modify: `apps/service/src/temporal/workflows/pipeline-workflow.ts`
- Modify: `apps/service/src/temporal/workflows/backfill-pipeline-workflow.ts`
- Modify: `apps/service/src/temporal/activities/_shared.ts`

### Step 1: Write failing test for drainMessages

Find `apps/service/src/` tests. Add to the relevant test file (or create `apps/service/src/temporal/activities/_shared.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { drainMessages } from './_shared.js'

async function* msgs<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

describe('drainMessages', () => {
  it('accumulates stream state messages into state.streams', async () => {
    const result = await drainMessages(msgs([
      { type: 'state', state: { state_type: 'stream', stream: 'orders', data: { cursor: 5 } } },
    ]))
    expect(result.state.streams).toEqual({ orders: { cursor: 5 } })
    expect(result.state.global).toEqual({})
  })

  it('accumulates global state messages into state.global', async () => {
    const result = await drainMessages(msgs([
      { type: 'state', state: { state_type: 'global', data: { events_cursor: 'evt_1' } } },
    ]))
    expect(result.state.global).toEqual({ events_cursor: 'evt_1' })
    expect(result.state.streams).toEqual({})
  })
}
```

### Step 2: Run to verify failure

```bash
pnpm --filter @stripe/sync-service test --reporter=verbose 2>&1 | grep -A5 "drainMessages"
```

### Step 3: Implement activities/\_shared.ts

**a) Import `SyncState`**:

```ts
import type { Message, Engine, SyncState } from '@stripe/sync-engine'
```

**b) Update `RunResult`**:

```ts
export interface RunResult {
  errors: Array<{ message: string; failure_type?: string; stream?: string }>
  state: SyncState
}
```

**c) Update `drainMessages` signature and accumulation**:

Change the function to:

```ts
export async function drainMessages(stream: AsyncIterable<Message>): Promise<{
  errors: RunResult['errors']
  state: SyncState
  records: Message[]
  controls: Array<Record<string, unknown>>
  eof?: { reason: string }
}> {
  const errors: RunResult['errors'] = []
  const state: SyncState = { streams: {}, global: {} }
  const records: Message[] = []
  const controls: Array<Record<string, unknown>> = []
  let eof: { reason: string } | undefined
  let count = 0

  for await (const message of stream) {
    count++
    if (message.type === 'eof') {
      eof = { reason: message.eof.reason }
    } else if (message.type === 'control') {
      if (message.control.control_type === 'connector_config') {
        controls.push(message.control.config)
      }
    } else {
      const error = collectError(message)
      if (error) {
        errors.push(error)
      } else if (message.type === 'state') {
        if (message.state.state_type === 'global') {
          Object.assign(state.global, message.state.data as Record<string, unknown>)
        } else {
          state.streams[message.state.stream] = message.state.data
        }
      } else if (message.type === 'record') {
        records.push(message)
      }
    }
    if (count % 50 === 0) heartbeat({ messages: count })
  }
  if (count % 50 !== 0) heartbeat({ messages: count })

  return { errors, state, records, controls, eof }
}
```

### Step 4: Implement workflows/\_shared.ts

Update `stateQuery` type:

```ts
import type { SyncState } from '@stripe/sync-engine'

// Change:
export const stateQuery = defineQuery<Record<string, unknown>>('state')
// To:
export const stateQuery = defineQuery<SyncState>('state')
```

### Step 5: Implement pipeline-workflow.ts

**a) Add `SyncState` to imports from `_shared.js`** (or import from `@stripe/sync-engine`).

**b) Update `PipelineWorkflowOpts`**:

```ts
export interface PipelineWorkflowOpts {
  state?: SyncState
  time_limit?: number
  inputQueue?: unknown[]
}
```

**c) Update `syncState` initial value and type**:

```ts
let syncState: SyncState = opts?.state ?? { streams: {}, global: {} }
```

**d) Update `stateQuery` handler**:

```ts
setHandler(stateQuery, (): SyncState => syncState)
```

**e) Update merge after `syncImmediate`**:

```ts
syncState = {
  streams: { ...syncState.streams, ...result.state.streams },
  global: { ...syncState.global, ...result.state.global },
}
```

**f) Update `continueAsNew` call** — state field is already `SyncState` compatible, no change needed.

### Step 6: Implement backfill-pipeline-workflow.ts

Same changes as pipeline-workflow.ts:

```ts
export interface BackfillPipelineWorkflowOpts {
  state?: SyncState
}
// ...
let syncState: SyncState = opts?.state ?? { streams: {}, global: {} }
setHandler(stateQuery, (): SyncState => syncState)
// merge:
syncState = {
  streams: { ...syncState.streams, ...result.state.streams },
  global: { ...syncState.global, ...result.state.global },
}
```

### Step 7: Run tests

```bash
pnpm --filter @stripe/sync-service test --reporter=verbose
```

### Step 8: Commit

```bash
git add \
  apps/service/src/temporal/workflows/_shared.ts \
  apps/service/src/temporal/workflows/pipeline-workflow.ts \
  apps/service/src/temporal/workflows/backfill-pipeline-workflow.ts \
  apps/service/src/temporal/activities/_shared.ts \
  apps/service/src/temporal/activities/_shared.test.ts
git commit -m "feat(service): thread SyncState through workflows + drainMessages"
```

---

## Task 8: Source-stripe — update state access to state.streams

### Files

- Modify: `packages/source-stripe/src/index.ts`
- Modify: `packages/source-stripe/src/src-list-api.ts`
- Modify: `packages/source-stripe/src/src-events-api.ts`

This task is purely mechanical: the `Source.read()` interface now receives `state?: SyncState`
instead of `state?: Record<string, TStreamState>`. The connector must access `state?.streams`
instead of `state` directly.

### Step 1: Update index.ts read() signature

In `index.ts`, the `read({ config, catalog, state }, $stdin?)` destructure already uses `state`
from the params type. The `Source` interface is satisfied as long as the implementation signature
is compatible. No explicit annotation needed — TypeScript infers it from the `Source<...>` implementation.

Check if there is a `implements Source<...>` or explicit typing — if so, update the state type.

### Step 2: Update src-list-api.ts

Find and replace all `state?.[stream.name]` and `state?.[name]` with `state?.streams[stream.name]` / `state?.streams[name]`.

Current pattern (line 402): `const streamState = state?.[stream.name]`
Change to: `const streamState = state?.streams[stream.name]`

Update the `listApiBackfill` function parameter type:

```ts
// Change the state param type from:
state: Record<string, StripeStreamState> | undefined
// to:
state: { streams: Record<string, StripeStreamState>; global: Record<string, unknown> } | undefined
```

All usages of `state?.[...]` become `state?.streams[...]`.

### Step 3: Update src-events-api.ts

Same pattern. The `pollEvents` function takes `state: Record<string, StripeStreamState> | undefined`.

Change parameter type to `state: { streams: Record<string, StripeStreamState>; global: Record<string, unknown> } | undefined` and replace all `state?.[name]` with `state?.streams[name]`.

Specifically:

- Line 26: `state?.[cs.stream.name]?.status` → `state?.streams[cs.stream.name]?.status`
- Line 32: `state?.[cs.stream.name]?.events_cursor` → `state?.streams[cs.stream.name]?.events_cursor`
- Line 39: `state?.[cs.stream.name]` → `state?.streams[cs.stream.name]`
- Line 86: `state?.[msg.state.stream]` → `state?.streams[msg.state.stream]`

### Step 4: Run source-stripe tests

```bash
pnpm --filter @stripe/sync-source-stripe test --reporter=verbose
```

### Step 5: Full build

```bash
pnpm build 2>&1 | tail -20
```

Expected: Zero errors.

### Step 6: Commit

```bash
git add packages/source-stripe/src/index.ts packages/source-stripe/src/src-list-api.ts packages/source-stripe/src/src-events-api.ts
git commit -m "feat(source-stripe): update state access to state.streams (SyncState type infra)"
```

---

## Task 9: Docs — update protocol-comparison.md

### Files

- Modify: `docs/architecture/protocol-comparison.md`

### Step 1: Update STATE comparison table

Replace the `state_type` row in the STATE section:

```markdown
| `state_type` | `enum(LEGACY, STREAM, GLOBAL)` | `enum('stream', 'global')` | We skip LEGACY; backward compat via preprocess default |
| `stream` | `AirbyteStreamState` object | `string` (stream name) | Only present on stream-type messages |
| `global` | `AirbyteGlobalState` object | `GlobalStatePayload` object | Sync-wide cursor (e.g. events_cursor) |
```

Update the **Key difference** paragraph:

```markdown
**Key difference:** Airbyte supports three state modes (legacy, per-stream, global).
We skip LEGACY and support both STREAM and GLOBAL via a `state_type` discriminated union.
Old messages without `state_type` are backward-compatibly parsed as `stream` type.
The `SyncState` aggregate shape (`{ streams, global }`) replaces the flat
`Record<string, unknown>` used previously.
```

### Step 2: Update Summary of Divergences

Change item 2:

```markdown
2. ~~**Per-stream state only** — no global or legacy state modes.~~ **Global state added** — `state_type: STREAM | GLOBAL` discriminator aligned with Airbyte (LEGACY skipped). Aggregate `SyncState = { streams, global }` replaces flat `Record<string, unknown>`.
```

Or simply remove the old item 2 and renumber, updating the description:

```markdown
2. **No legacy state** — we support `stream` and `global` modes but skip `LEGACY`.
```

### Step 3: Commit

```bash
git add docs/architecture/protocol-comparison.md
git commit -m "docs: update STATE comparison — close gap #2 (global state now supported)"
```

---

## Verification Checklist

After all tasks complete, run:

```bash
# Full build
pnpm build

# All unit tests
pnpm test

# Format + lint
pnpm format:check && pnpm lint

# Backward compat smoke test (old flat X-State header still parses)
# Manually: curl with X-State: '{"orders": {"cursor": 1}}' should work (wrapped as { streams: {orders:...}, global: {} })
```

Also verify:

- `pnpm test` covers the new `SyncState` parse tests
- `pnpm test` covers `drainMessages` accumulating both stream and global state
- `pnpm test` covers `persistState` routing to `setGlobal` for global messages
- `pnpm test` covers `enforceCatalog` passing global state through

The Postgres `_global` row test requires `DATABASE_URL` set (integration test).
