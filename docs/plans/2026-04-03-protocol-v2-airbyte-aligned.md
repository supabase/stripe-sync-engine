# Protocol v2: Airbyte-aligned Everything-is-a-Stream

## Context

Align the sync-engine protocol with Airbyte's design: wrapper envelope messages, everything is a stream, TraceMessage for errors/status, HTTP endpoints return NDJSON. This is on the `v2` branch so breaking changes are fine.

## Three Structural Changes

### 1. Wrapper Envelope (Airbyte-style)

**Before (flat):**
```json
{"type":"record","stream":"customers","data":{...},"emitted_at":"..."}
```

**After (envelope):**
```json
{"type":"record","record":{"stream":"customers","data":{...},"emitted_at":"..."}}
```

- Type discriminator uses lowercase values: `record`, `state`, `log`, `spec`, `connection_status`, `catalog`, `control`, `trace`, `eof`
- Each variant has exactly one payload field matching the type name
- Inner payload schemas are the "content" types (no `type` field of their own)

### 2. TraceMessage replaces ErrorMessage + StreamStatusMessage

Single `trace` message with subtypes:

```json
{"type":"trace","trace":{"trace_type":"error","error":{"failure_type":"config_error","message":"...","stream":"...","stack_trace":"..."}}}
{"type":"trace","trace":{"trace_type":"stream_status","stream_status":{"stream":"customers","status":"running"}}}
{"type":"trace","trace":{"trace_type":"estimate","estimate":{"stream":"customers","row_count":1000}}}
```

### 3. All HTTP endpoints return NDJSON streams

`/check`, `/discover`, `/setup`, `/teardown` switch from JSON responses to NDJSON streams, mirroring the protocol 1:1. Every endpoint can emit log messages before its primary output.

---

## Message Types (Complete)

### Payload schemas (no `type` field — these are the inner objects)

```typescript
// Existing payloads (renamed from XxxMessage to Xxx or XxxPayload)
Record     = { stream, data, emitted_at }
State      = { stream, data }
Catalog    = { streams: Stream[] }
Log        = { level: 'debug'|'info'|'warn'|'error', message }
Eof        = { reason: 'complete'|'state_limit'|'time_limit'|'error' }

// New payloads
Spec             = { config, stream_state?, input? }  // same as current ConnectorSpecification
ConnectionStatus = { status: 'succeeded'|'failed', message? }
Control          = { control_type: 'config_update', config: Record<string,unknown> }
Trace            = discriminated on trace_type:
  | { trace_type: 'error', error: { failure_type, message, stream?, stack_trace? } }
  | { trace_type: 'stream_status', stream_status: { stream, status } }
  | { trace_type: 'estimate', estimate: { stream, row_count?, byte_count? } }
```

### Envelope messages (the top-level wire format)

```typescript
Message = discriminatedUnion('type', [
  { type: 'record',            record: Record },
  { type: 'state',             state: State },
  { type: 'catalog',           catalog: Catalog },
  { type: 'log',               log: Log },
  { type: 'trace',             trace: Trace },
  { type: 'spec',              spec: Spec },
  { type: 'connection_status', connection_status: ConnectionStatus },
  { type: 'control',           control: Control },
  { type: 'eof',               eof: Eof },
])
```

### Per-command output types

```typescript
SpecOutput           = Message where type in [spec, log, trace]
CheckOutput          = Message where type in [connection_status, log, trace]
DiscoverOutput       = Message where type in [catalog, log, trace]
SetupOutput          = Message where type in [control, log, trace]
TeardownOutput       = Message where type in [log, trace]
ReadOutput           = Message  // all types
DestinationInput     = Message where type in [record, state]
DestinationOutput    = Message where type in [state, trace, log, eof]
```

---

## Interface Changes

### Source
```typescript
interface Source<TConfig, TStreamState, TInput> {
  spec():                                          AsyncIterable<SpecOutput>
  check(p: {config}):                              AsyncIterable<CheckOutput>
  discover(p: {config}):                           AsyncIterable<DiscoverOutput>
  read(p: {config, catalog, state?}, $stdin?):     AsyncIterable<Message>
  setup?(p: {config, catalog}):                    AsyncIterable<SetupOutput>
  teardown?(p: {config}):                          AsyncIterable<TeardownOutput>
}
```

### Destination
```typescript
interface Destination<TConfig> {
  spec():                                          AsyncIterable<SpecOutput>
  check(p: {config}):                              AsyncIterable<CheckOutput>
  write(p: {config, catalog}, $stdin):             AsyncIterable<DestinationOutput>
  setup?(p: {config, catalog}):                    AsyncIterable<SetupOutput>
  teardown?(p: {config}):                          AsyncIterable<TeardownOutput>
}
```

---

## Files to Modify

### Phase 1: Protocol package

**`packages/protocol/src/protocol.ts`** — the core change
- Replace all flat message schemas with payload schemas + envelope wrappers
- Add `Trace` discriminated union (error | stream_status | estimate subtypes)
- Add `Spec`, `ConnectionStatus`, `Control` payload schemas
- Build `Message` as envelope discriminated union
- Redefine per-command output types
- Change `Source` and `Destination` interfaces (all methods → AsyncIterable)
- Remove/deprecate `CheckResult`, `ErrorMessage`, `StreamStatusMessage`

**`packages/protocol/src/helpers.ts`**
- Update all type guards to use envelope shape: `isRecord(m)` checks `m.type === 'record'`
- Update `toRecordMessage` → wraps in envelope
- Add `collectFirst<T>(stream, typeName)` helper — drains a message stream, returns first message of given type, logs logs, throws on trace errors

**`packages/protocol/src/cli.ts`**
- All subcommands become: iterate async iterable, `writeLine` each message
- Remove per-command special handling (no more `writeLine(spec)` vs `for await`)
- Uniform: `for await (const msg of connector.spec()) writeLine(msg)`

**`packages/protocol/src/ndjson.ts`**
- No changes needed (already generic)

**`packages/protocol/src/index.ts`**
- Update exports

### Phase 2: Engine

**`apps/engine/src/lib/source-exec.ts`**
- All commands use `spawnAndStream` (uniform NDJSON)
- `spec()`: returns async iterable of spec messages from subprocess
- `check()`: returns async iterable of connection_status messages
- `discover()`: returns async iterable of catalog messages
- `setup()`: returns async iterable of control messages
- `teardown()`: returns async iterable of log/trace messages
- `read()`: unchanged pattern (already streaming)
- Remove `spawnSync` for spec (now async)

**`apps/engine/src/lib/destination-exec.ts`**
- Same changes as source-exec for spec, check, setup, teardown
- `write()`: unchanged

**`apps/engine/src/lib/engine.ts`**
- `Engine` interface: `setup()` → returns `SetupResult` (extracted from streams internally)
- `createEngine()`: uses `collectFirst` to extract primary payloads from connector streams
- `spec()` becomes async — engine construction needs adjustment (lazy spec validation or async factory)
- `setup()`: iterate setup streams, collect control messages, merge config
- `check()`: iterate check streams, extract connection_status
- `discover()` (via `getCatalog`): iterate discover stream, extract catalog

**`apps/engine/src/api/app.ts`**
- ALL routes return NDJSON (`application/x-ndjson`)
- `/check`: stream connection_status + logs
- `/discover`: stream catalog + logs
- `/setup`: stream control + logs
- `/teardown`: stream logs + trace
- `/read`, `/write`, `/sync`: already NDJSON, just update message shapes

**`apps/engine/src/lib/remote-engine.ts`**
- All methods now parse NDJSON responses (including check, discover, setup, teardown)
- Use `collectFirst` pattern for non-streaming consumers

### Phase 3: Connectors (hard cutover)

**`packages/source-stripe/src/index.ts`**
- All methods become `async *` generators yielding envelope messages
- `spec()` → `yield { type: 'spec', spec: { config: ... } }`
- `check()` → `yield { type: 'connection_status', connection_status: { status: 'succeeded' } }`
- `discover()` → `yield { type: 'catalog', catalog: { streams: [...] } }`
- `setup()` → `yield { type: 'control', control: { control_type: 'config_update', config: {...} } }`
- `teardown()` → yield log messages or nothing
- `read()` → yield envelope-wrapped record, state, trace, etc.

**`packages/destination-postgres/src/index.ts`** — same pattern

**`packages/destination-google-sheets/src/index.ts`** — same pattern

### Phase 4: Service + tests

**`apps/service/`** — update any direct protocol message references

**Test files:**
- `packages/protocol/src/__tests__/cli.test.ts`
- `apps/engine/src/lib/exec.test.ts`
- `apps/engine/src/lib/engine.test.ts` (if exists)
- `e2e/` tests
- Connector-level tests

---

## What We're NOT Doing

1. **No legacy adapters** — hard cutover, all connectors updated at once
2. **No camelCase** — Airbyte uses `connectionStatus` but we use `connection_status` per our snake_case convention
3. **No analytics trace type** — just error, stream_status, estimate for now (extensible later)

## Verification

1. `pnpm build` — all packages compile
2. `pnpm test` — unit tests pass
3. `pnpm lint && pnpm format:check` — clean
4. Manual CLI: `source-stripe spec` → `{"type":"spec","spec":{...}}`
5. Manual CLI: `source-stripe check --config '...'` → `{"type":"connection_status","connection_status":{"status":"succeeded"}}`
6. HTTP API: `curl /check` returns NDJSON with connection_status line
7. E2E: full sync works end-to-end with envelope messages
