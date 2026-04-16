# Pipeline Workflow: Dual-Lane Clarity Notes

This note captures what became clearer as we iterated on
`apps/service/src/temporal/workflows/pipeline-workflow.ts`.

## Before

The original workflow worked, but it was harder to read because several concerns
were interleaved:

- lifecycle control (`active`, `paused`, `deleted`)
- derived pipeline status (`setup`, `backfill`, `ready`, `paused`, `teardown`)
- persisted workflow state
- live lane work
- backfill/reconcile lane work

That showed up in a few concrete ways:

- both loops knew too much about lifecycle state
- booleans such as `eofCompleted` and `setupDone` carried phase meaning indirectly
- `condition(...)` results were interpreted through awkward boolean inversions
- status updates were spread across multiple places
- terminal actions and rollover logic were farther from the places where the run
  actually stopped

## After

The current direction is simpler:

- the workflow persists a single `state` object
- the workflow derives external pipeline status from persisted state plus
  `desiredStatus`
- each lane has a co-located wait helper
- wait helpers decide only whether work should run next
- state transitions happen explicitly in the loop after a real event
- `continueAsNew(...)` happens in the active path, not after teardown

## Principles

### 1. Keep workflow control at the root

The root should own:

- setup
- pause handling
- delete handling
- continue-as-new
- teardown

Loops should focus on doing work, not on orchestrating the whole workflow.

### 2. Persist one workflow state object

Use one persisted `state` object inside workflow options rather than parallel
top-level booleans.

That keeps rollover payloads smaller and makes persisted state easier to reason
about as one concept.

### 3. Use explicit phase names instead of overloaded booleans

`phase: 'backfilling' | 'reconciling' | 'ready'` is easier to read than a
boolean such as `backfillComplete`.

Booleans hide transitions. Phases make transitions visible.

### 4. Derive pipeline status instead of storing it separately

The workflow should compute pipeline status from current facts rather than
tracking a second mutable `workflowStatus` field.

This avoids drift between:

- persisted workflow state
- desired lifecycle state
- externally reported pipeline status

### 5. Distinguish desired state from actual workflow state

`desiredStatus` is requested intent from outside the workflow.

The persisted workflow `state` is what the workflow is actually doing.

Those are not always the same thing. For example:

- `desiredStatus` can become `paused` while an in-flight activity is still
  finishing
- `desiredStatus` can become `deleted` before teardown has actually started

Keep both concepts explicit and avoid pretending one can stand in for the other.

### 6. Keep pause and teardown as explicit lifecycle transitions

Derived pipeline status should cover phase-driven status such as:

- `setup`
- `backfill`
- `ready`

Lifecycle transitions such as:

- `paused`
- `teardown`

should usually be written explicitly in root control flow instead of being
smuggled into a generic derived-status helper.

### 7. Wait helpers should gate work, not mutate state

A wait helper should answer:

- is there work to do now?
- should the loop stop?

State changes should happen explicitly in the loop after the relevant event is
observed.

Examples:

- when `phase` is empty, the reconcile loop can set it to `backfilling`
- when `phase` is `ready`, the reconcile loop can set it to `reconciling`
- when `pipelineSync(...)` reaches EOF complete, the reconcile loop can set it
  to `ready`

### 8. Co-locate each wait helper with its loop

`waitForLiveEvents()` should sit next to `liveLoop()`.

`waitForReconcileTurn()` should sit next to `reconcileLoop()`.

That keeps loop-specific control flow local without nesting helpers inside the
loop function body.

### 9. Prefer one compound `condition(...)` over clever boolean interpretation

Using one `condition(...)` to describe what can wake the loop is good.

What made the old version hard to read was not the compound condition itself.
It was trying to infer too much from the boolean returned by `condition(...)`.

The clearer pattern is:

1. wait for the relevant wake-up conditions
2. inspect current workflow state after waking
3. decide whether to run or stop

### 10. Name helpers after workflow meaning, not loop mechanics

`runInterrupted()` is better than names like `shouldInterruptLoop()` because it
describes workflow state, not implementation shape.

The workflow should read in domain terms first and control-flow terms second.

### 11. Keep terminal work on the terminal path

Teardown should remain in the terminal delete path.

`continueAsNew(...)` should happen only on the rollover path.

That makes it obvious that:

- delete ends the current workflow
- rollover starts a new run

### 12. Prefer meaningful loop conditions over `while (true)` when possible

If delete is the terminal path, `while (desiredStatus !== 'deleted')` is clearer
than `while (true)` followed by an immediate delete check inside the loop.

Use `while (true)` only when the exits genuinely belong inside the body.

### 13. Update external status only when something actually changed

Avoid sprinkling `updatePipelineStatus(...)` through control flow just because
execution passed through a branch or loop.

Prefer:

- state-driven updates via `setState(...)`
- explicit lifecycle updates for `paused` and `teardown`

That keeps status writes aligned with real transitions instead of incidental
control flow.

### 14. Internal workflow state can be richer than the external API status

It is fine for workflow-local state to track more detail than the API exposes.

For example, the workflow may track internal lifecycle phases such as:

- `setup: 'started' | 'completed'`
- `teardown: 'started' | 'completed'`

while the external pipeline status still exposes only `setup` or `teardown`.

That keeps the workflow implementation explicit without forcing every internal
transition into the public API contract.

### 15. Symmetry helps readability

If setup is tracked explicitly, teardown usually should be tracked explicitly in
the same style.

Likewise, if one lifecycle transition uses `setState(...)`, nearby lifecycle
transitions should usually follow the same pattern unless there is a strong
reason not to.

## Rule of Thumb

If a line makes the reader mentally simulate both Temporal semantics and local
workflow state at the same time, it is probably too clever.

Prefer code that answers one question at a time:

- should this run continue?
- should this lane do work now?
- what phase are we in?
- what pipeline status should we report?
