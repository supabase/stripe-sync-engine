# Backfill Child Workflow: Extract `backfillLoop` from `pipelineWorkflow`

**Status**: Plan (not yet implemented)
**Related**: [Never-Fail Workflow](2026-04-14-never-fail-workflow.md) (error model changes that complement this restructuring)

## Problem

`pipelineWorkflow` is a monolithic workflow that handles setup, backfill, live events, reconciliation, error recovery, pause/resume, teardown, and `continueAsNew` housekeeping in one event history.

- **Backfill has no completion semantics.** "Is the backfill done?" requires inspecting internal `phase` state. There's no workflow execution you can point to and say "that's the backfill, it completed at 3pm."
- **Event history bloat.** A full backfill can invoke `pipelineSync` hundreds of times. This dominates the history and drives the `CONTINUE_AS_NEW_THRESHOLD` of 500 operations.
- **No failure isolation.** A poison stream during backfill errors the entire pipeline, stopping live event processing that may be perfectly healthy.
- **Heavy `continueAsNew` payload.** The workflow serializes all `sourceState` (stream cursors, segment state, backfill progress) through every boundary.
- **Backfill and reconcile are the same operation** but wired differently with separate phase labels and control flow. Both call `pipelineSync` with `state` + limits, which runs `listApiBackfill`, which skips complete streams and paginates incomplete ones. The only difference is starting state.

## Design

Extract the `reconcileLoop` into a child workflow called `backfillLoop`. The pipeline workflow becomes a lightweight entity that manages lifecycle and spawns bounded tasks.

### Architecture

```
pipelineWorkflow (entity — lives forever, never fails)
│
├── setup (activity)
│
├── executeChild(backfillLoop, { state: {} })          ← initial backfill
│   └── calls pipelineSync in a loop until complete
│   └── returns final sourceState + any errors
│
├── main loop:
│   ├── receive live events via signal → pipelineSync (activity)
│   ├── on schedule or signal:
│   │   └── executeChild(backfillLoop, { state })      ← reconcile
│   │       └── skips complete streams, completes
│   └── continueAsNew when needed (lightweight)
│
├── on error: park, wait for recovery signal
└── on delete: teardown (activity)
```

### `backfillLoop` child workflow

A finite workflow that takes a source state, advances all incomplete streams to completion, and returns the final state. Same code path for initial backfill and reconciliation — the only difference is the input state.

```ts
export async function backfillLoop(
  pipelineId: string,
  opts: { state: SourceState }
): Promise<BackfillLoopResult> {
  let sourceState = opts.state
  let operationCount = 0

  while (true) {
    const result = await pipelineSync(pipelineId, {
      state: sourceState,
      state_limit: 100,
      time_limit: 10,
    })
    operationCount++
    sourceState = result.state

    if (result.errors.length > 0) {
      return { state: sourceState, errors: result.errors, completed: false }
    }

    if (result.eof?.reason === 'complete') {
      return { state: sourceState, errors: [], completed: true }
    }

    if (operationCount >= BACKFILL_CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof backfillLoop>(pipelineId, { state: sourceState })
    }
  }
}

interface BackfillLoopResult {
  state: SourceState
  errors: SyncRunError[]
  completed: boolean
}
```

Properties:

- **Finite**: runs until all streams complete or an error stops it
- **Own event history**: backfill pagination doesn't bloat the pipeline workflow
- **Own `continueAsNew`**: manages its own history size independently
- **Returns a result**: parent gets final state + success/error status
- **Deterministic workflow ID**: `backfill-{pipelineId}` for initial, `reconcile-{pipelineId}-{timestamp}` for scheduled runs — so the parent can find them after its own `continueAsNew`

Note: error handling inside `backfillLoop` (transient retry, escalation) is covered in the [Never-Fail Workflow](2026-04-14-never-fail-workflow.md) plan. The version above returns immediately on any error; the never-fail plan adds bounded in-workflow retry for transient errors before returning.

### Why child workflow, not just activities

- A backfill can run for hours with thousands of pages — it needs its own event history budget
- It needs its own `continueAsNew` cadence, independent of the pipeline
- It has clear completion semantics ("the backfill is done" = "the workflow completed")
- Future: it could receive signals (e.g., "skip this stream", "pause backfill")

### Why `pipelineSetup` and `pipelineTeardown` stay as activities

- Short, bounded operations (2 min timeout)
- No independent lifecycle needed
- No signals or complex state management
- Activity retry is appropriate for transient network errors

### Simplified `pipelineWorkflow`

```ts
export async function pipelineWorkflow(
  pipelineId: string,
  opts?: PipelineWorkflowOpts
): Promise<void> {
  let desiredStatus = opts?.desiredStatus ?? 'active'
  let sourceState = opts?.sourceState ?? { streams: {}, global: {} }
  let state: PipelineWorkflowState = { ...opts?.state }
  // ... signal handlers, setState, etc.

  // Setup
  if (state.setup !== 'completed') {
    await setState({ setup: 'started' })
    await pipelineSetup(pipelineId)
    await setState({ setup: 'completed' })
  }

  // Initial backfill
  if (state.phase !== 'ready') {
    await setState({ phase: 'backfilling' })
    const result = await executeChild(backfillLoop, {
      workflowId: `backfill-${pipelineId}`,
      args: [pipelineId, { state: sourceState }],
    })
    sourceState = result.state
    if (!result.completed) {
      await handleErrors(result.errors)
    } else {
      await setState({ phase: 'ready' })
    }
  }

  // Main loop
  while (desiredStatus !== 'deleted') {
    if (state.errored) {
      await waitForErrorRecovery()
      continue
    }
    if (desiredStatus === 'paused') {
      await waitForResume()
      continue
    }

    await Promise.all([
      liveLoop(), // signals → pipelineSync activity
      reconcileScheduler(), // periodic backfillLoop child workflows
    ])

    if (shouldContinueAsNew()) {
      await continueAsNew<typeof pipelineWorkflow>(pipelineId, {
        desiredStatus,
        sourceState,
        state,
      })
    }
  }

  // Teardown
  await setState({ teardown: 'started' })
  await pipelineTeardown(pipelineId)
  await setState({ teardown: 'completed' })
}
```

The `continueAsNew` payload shrinks significantly — `sourceState` is just the last completed checkpoint, not in-flight pagination cursors. `inputQueue` is no longer serialized (Temporal buffers signals).

### Reconcile as a scheduled backfill

Reconciliation is "run `backfillLoop` again with the current state." The pipeline workflow schedules it:

```ts
async function reconcileScheduler(): Promise<void> {
  while (!runInterrupted()) {
    await condition(() => reconcileRequested || runInterrupted(), ONE_WEEK_MS)
    if (runInterrupted()) return

    await setState({ phase: 'reconciling' })
    const result = await executeChild(backfillLoop, {
      workflowId: `reconcile-${pipelineId}-${Date.now()}`,
      args: [pipelineId, { state: sourceState }],
    })
    sourceState = result.state
    if (!result.completed) {
      await handleErrors(result.errors)
      return
    }
    await setState({ phase: 'ready' })
  }
}
```

## Observability

- **Is the backfill done?** → check if `backfill-{pipelineId}` child workflow completed
- **How long did backfill take?** → child workflow start/end timestamps
- **Which reconcile runs happened?** → list child workflows matching `reconcile-{pipelineId}-*`
- **Is it making progress?** → child workflow heartbeats / operation count

All visible in the Temporal UI without custom dashboards.

## Implementation

### Phase 1: Create `backfillLoop` child workflow

1. Create `apps/service/src/temporal/workflows/backfill-loop.ts`
2. Define `BackfillLoopResult` type
3. Register in worker alongside `pipelineWorkflow`
4. Use same activity proxies (`pipelineSync`) with same timeout/retry config

### Phase 2: Rewire `pipelineWorkflow`

1. Replace inline `reconcileLoop` with `executeChild(backfillLoop, ...)`
2. Handle child workflow result (errors, state, completed)
3. Move `sourceState` management to only update on child completion
4. Add `reconcileScheduler` for periodic reconcile runs
5. Keep `liveLoop` as-is (activities within the pipeline workflow)

### Phase 3: Simplify `continueAsNew`

1. Remove `inputQueue` from `continueAsNew` payload
2. `sourceState` is now just the last completed checkpoint
3. Raise or remove `CONTINUE_AS_NEW_THRESHOLD` — the pipeline workflow generates far fewer events

### Migration

Existing running workflows need to transition. Deploy new workflow code, let existing workflows `continueAsNew` into the new shape. The new `pipelineWorkflow` accepts the old `PipelineWorkflowOpts` format — if `state.phase === 'backfilling'` and no child is running, spawn one.

## Constants

```ts
const BACKFILL_CONTINUE_AS_NEW_THRESHOLD = 500 // for backfillLoop
const PIPELINE_CONTINUE_AS_NEW_THRESHOLD = 1000 // pipeline is much lighter now
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000 // reconcile schedule
```

## Open questions

1. **Should the parent pause live events during initial backfill?** Currently live and reconcile run in parallel via `Promise.all`. With a child workflow, they're still concurrent. Should we avoid writing to the same streams from both paths?
2. **Per-stream child workflows (future)?** This plan extracts the backfill loop as a single child. A future iteration could spawn per-stream children for independent failure isolation (Airbyte model).
3. **Backfill progress reporting.** Today `updatePipelineStatus` fires on phase transitions. With a child workflow, we could also report progress (e.g., "47/50 streams complete") via queries or heartbeats.
4. **Child workflow survival across `continueAsNew`.** Child workflows don't carry over when the parent continues-as-new. Use deterministic workflow IDs so the parent can re-attach after its own `continueAsNew`.
