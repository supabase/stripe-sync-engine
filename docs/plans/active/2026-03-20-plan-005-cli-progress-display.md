# Plan: Add CLI Backfill Progress Display

## Context

The old monolith (`packages/sync-engine`) had a database-backed progress display: workers updated a `sync_obj_progress` table, and the CLI queried it every 1-2s to render progress bars with `pct_complete` and row counts using ANSI escape codes:

```
  customers                [████████████░░░░░░░░] 50.0%  (1000 rows)
  invoices                 [██████░░░░░░░░░░░░░░] 30.0%  (567 rows)
```

That was deleted in the protocol refactor (commit `091cb7af`).

The new protocol-based architecture has the building blocks (`StreamStatusMessage`, `RouterCallbacks`) but doesn't wire them up for display. The CLI currently outputs raw NDJSON to stdout with status lines on stderr — no live progress indicators.

**Key constraint**: Stripe list APIs don't expose total counts, so we can't show `pct_complete`. The new display focuses on record counts + stream status.

## Design

### Layer 1: Protocol — add `onRecord` callback

`RouterCallbacks` currently has `onLog`, `onError`, `onStreamStatus`. The `forward()` function yields `RecordMessage` to the destination but never notifies callbacks about records flowing through. Add one field:

```ts
// packages/sync-protocol/src/filters.ts

export type RouterCallbacks = {
  onLog?: (message: string, level: string) => void
  onError?: (message: string, failureType: string) => void
  onStreamStatus?: (stream: string, status: string) => void
  onRecord?: (stream: string) => void // NEW
}
```

In `forward()`, call `onRecord` for each `RecordMessage` before yielding it to the destination:

```ts
if (isDataMessage(msg)) {
  if (msg.type === 'record') {
    callbacks?.onRecord?.(msg.stream)
  }
  yield msg
}
```

This is the minimal protocol change — one optional callback, one call site. Fully backwards-compatible (existing code passes no `onRecord`).

### Layer 2: CLI — progress display

The `runCommand` creates an engine with default stderr callbacks. Change it to pass custom callbacks that track per-stream state and render progress to stderr when it's a TTY.

**Progress state** (in-memory, per run):

```ts
type StreamProgress = { records: number; status: string }
const streams = new Map<string, StreamProgress>()
```

**Callbacks** wire into `createEngine(params, connectors, callbacks)`:

- `onStreamStatus(stream, status)` → update `streams.get(name).status`
- `onRecord(stream)` → increment `streams.get(name).records`
- `onLog` / `onError` → print to stderr (same as current defaults)

**Display** (stderr, TTY only):

- After each callback, re-render the progress table using ANSI escapes (`\x1B[{n}A` move up, `\x1B[2K` clear line)
- Format per stream: `  ✓ customers     1,234 records` / `  ⠋ invoices        567 records`
- Simple spinner character cycle for active streams
- Final summary line: `Synced 4 streams (12,345 total records)`

**Non-TTY mode** (piped stderr): fall back to one-line-per-status-change (same as current defaults). NDJSON stdout output is never affected.

### `resolveEngine` change

Currently `resolveEngine()` creates the engine with no callbacks (uses defaults). Accept optional callbacks:

```ts
async function resolveEngine(params: SyncParams, callbacks?: RouterCallbacks) {
  // ...
  return createEngine(params, { source, destination }, callbacks)
}
```

Only `runCommand` passes progress callbacks. Other commands keep defaults.

## Files

| File                                    | Change                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `packages/sync-protocol/src/filters.ts` | Add `onRecord` to `RouterCallbacks`, call it in `forward()`              |
| `apps/cli/src/cli/engine-commands.ts`   | Add progress tracking callbacks + TTY rendering, pass to `resolveEngine` |

## Key references

- `packages/sync-protocol/src/filters.ts:63-90` — `RouterCallbacks` type + `forward()` function
- `packages/sync-protocol/src/engine.ts:29-35` — default `stderrCallbacks`
- `packages/sync-protocol/src/engine.ts:69-73` — `createEngine()` signature accepting callbacks
- `apps/cli/src/cli/engine-commands.ts:20-26` — `resolveEngine()` where callbacks are wired
- `apps/cli/src/cli/engine-commands.ts:82-88` — `runCommand` entry point

## Verification

```sh
pnpm build
pnpm lint

# Manual test: run a real sync and verify progress renders on stderr
sync-engine run --params '...'

# Pipe test: progress on stderr, NDJSON on stdout
sync-engine run --params '...' > output.ndjson   # stderr shows progress
sync-engine run --params '...' 2>/dev/null        # stdout is clean NDJSON

# Existing tests still pass (callbacks are optional)
pnpm --filter sync-protocol test
pnpm --filter cli test
pnpm --filter sync-service test
```
