# Never-Fail Workflow: Entity-Based Error Model

**Status**: Plan (not yet implemented)
**Context**: [PR #284](https://github.com/stripe/sync-engine-fork/pull/284) cleaned up `SKIPPABLE_ERROR_PATTERNS`
**Related**: [Backfill Child Workflow](2026-04-14-backfill-child-workflow.md) (structural changes that complement this error model)

## Problem

The pipeline workflow has a hidden failure path: when `pipelineSync` encounters only transient/system errors, it throws `ApplicationFailure.retryable`. Temporal retries up to 10 times (1s → 2s → 4s → … → 5m cap). If the error persists, **the workflow execution dies** — losing its position in the main loop, requiring a new execution, and creating operational toil.

This is the wrong behavior for a sync pipeline. A connection is a long-lived entity. Errors are states within that entity, not reasons to terminate it.

### Current error flow

```
Source error → errorToTrace() → drainMessages() → classifySyncErrors():
  permanent (auth_error, config_error) → activity returns → workflow parks ✓
  transient (system_error, transient_error) → activity throws → retries → DIES ✗
```

### What `system_error` retries look like in practice

| Error                      | Self-heals? | 10 retries useful? |
| -------------------------- | ----------- | ------------------ |
| Rate limit (429)           | Yes         | Yes                |
| Stripe 5xx                 | Usually     | Yes                |
| Network timeout            | Usually     | Yes                |
| Connector bug (bad params) | No          | No — 30 min wasted |
| Schema mismatch            | No          | No                 |
| JSON parse failure         | No          | No                 |

Most `system_error` cases are deterministic. Retrying them wastes time and API quota before the workflow dies anyway.

### `pipelineSetup` discards `failure_type`

`collectMessages` in `packages/protocol/src/helpers.ts` throws a plain `Error` on any trace error, losing the `failure_type`. So a `config_error` during setup gets retried identically to a network blip.

## Industry patterns

**Airbyte**: Per-stream `INCOMPLETE` status — one broken stream doesn't fail the sync. Auto-disables connections after 100 consecutive failures or 14 days. Disabled = `INACTIVE` (resumable), not deleted.

**Fivetran**: Config errors set `setup_state: broken`, pausing until the user fixes it. Sync failures retry indefinitely by default.

**Temporal entity workflow**: Long-lived workflows that never fail by design. Errors are state transitions. Signals drive recovery.

**Temporal failure handling**: Platform-level failures (network) → retry automatically. Application-level failures (bad input) → `NonRetryableErrorTypes` to fail fast, handle in workflow with business logic.

## Design

### Principle: the workflow never fails

The pipeline workflow is an entity. It runs until explicitly deleted. Every error is a state transition, never a workflow termination. The only thing that ends a workflow execution is `continueAsNew` or deletion.

### Change 1: Activity never throws for classified errors

**Current** (`pipeline-sync.ts`):

```ts
if (transient.length > 0) {
  throw ApplicationFailure.retryable(summarizeSyncErrors(transient), 'TransientSyncError')
}
```

**Proposed**: The activity always returns — never throws for classified errors.

```ts
if (errors.length > 0) {
  return { errors, state, eof }
}
```

The workflow handles classification and retry:

```ts
const { transient, permanent } = classifySyncErrors(result.errors)

if (permanent.length > 0) {
  await markPermanentError(result.errors)
  return
}

if (transient.length > 0) {
  transientFailureCount++
  if (transientFailureCount >= MAX_TRANSIENT_RETRIES) {
    await markPermanentError(result.errors)
    return
  }
  await sleep(backoff(transientFailureCount))
  continue
}

transientFailureCount = 0 // reset on success
```

This keeps the workflow alive. Transient errors that won't self-heal eventually escalate to the errored state, where the workflow parks and waits for a signal.

**Tradeoff**: We lose Temporal's built-in retry machinery (backoff, attempt counting, visibility in the UI as "retrying"). We gain: the workflow never dies, operators can always signal recovery, and we can implement smarter retry strategies (per-stream, circuit breaker) in workflow code.

### Change 2: Reclassify `system_error`

Split the catch-all `system_error` into genuinely transient vs. deterministic:

| Error                        | Current type      | Proposed type                 |
| ---------------------------- | ----------------- | ----------------------------- |
| Rate limit (429)             | `transient_error` | `transient_error` (no change) |
| Auth (401/403)               | `auth_error`      | `auth_error` (no change)      |
| Network timeout / ECONNRESET | `system_error`    | `transient_error`             |
| Stripe 5xx                   | `system_error`    | `transient_error`             |
| JSON parse failure           | `system_error`    | `system_error` → permanent    |
| Connector bug (bad params)   | `system_error`    | `system_error` → permanent    |
| Unknown stream               | `config_error`    | `config_error` (no change)    |

The classifier expands:

```ts
const PERMANENT_FAILURE_TYPES = new Set(['config_error', 'auth_error', 'system_error'])
```

And `errorToTrace` gets better classification:

```ts
function classifyError(err: unknown): TraceError['failure_type'] {
  if (err instanceof StripeApiRequestError) {
    if (err.status === 401 || err.status === 403) return 'auth_error'
    if (err.status === 429) return 'transient_error'
    if (err.status >= 500) return 'transient_error'
  }
  if (isNetworkError(err)) return 'transient_error'
  if (err instanceof Error && err.message.includes('Rate limit')) return 'transient_error'
  return 'system_error' // deterministic by default
}
```

Only `transient_error` gets retried. Everything else parks.

### Change 3: Preserve `failure_type` through `collectMessages`

**Current** (`packages/protocol/src/helpers.ts`):

```ts
} else if (msg.type === 'trace' && msg.trace.trace_type === 'error') {
  throw new Error(msg.trace.error.message)
}
```

**Proposed**:

```ts
export class TraceErrorException extends Error {
  constructor(
    public readonly failure_type: TraceError['failure_type'],
    message: string,
    public readonly stream?: string
  ) {
    super(message)
    this.name = 'TraceErrorException'
  }
}

// In collectMessages:
} else if (msg.type === 'trace' && msg.trace.trace_type === 'error') {
  throw new TraceErrorException(
    msg.trace.error.failure_type,
    msg.trace.error.message,
    msg.trace.error.stream
  )
}
```

Then `pipelineSetup` can distinguish config errors from transient ones instead of retrying everything blindly.

### Recovery signals

| Signal                   | Trigger                | Workflow action                                    |
| ------------------------ | ---------------------- | -------------------------------------------------- |
| `desired_status: active` | User re-enables        | Clear errored state, re-enter main loop (existing) |
| `credentials_updated`    | User rotates API key   | Clear if `auth_error`                              |
| `config_updated`         | User modifies config   | Clear, re-run setup if needed                      |
| `deployment_updated`     | New connector deployed | Clear if `system_error`                            |

Today only `desired_status: active` triggers recovery. The others let the workflow react to specific fixes without requiring the user to manually toggle the pipeline.

## Implementation order

### Phase 1: Activity never throws (Change 1)

Highest impact, eliminates the workflow-death path. Can ship independently.

1. Modify `pipeline-sync.ts`: always return errors, never throw
2. Add in-workflow retry logic to wherever `pipelineSync` is called (current `reconcileLoop`, or `backfillLoop` if the child workflow plan lands first)
3. Add `transientFailureCount` + `backoff` + escalation to `markPermanentError`

### Phase 2: Preserve `failure_type` (Change 3)

Small, independent. Fixes setup/discover retry behavior.

1. Add `TraceErrorException` to `packages/protocol`
2. Update `collectMessages` to throw it
3. Update `pipelineSetup` activity to handle typed errors

### Phase 3: Reclassify `system_error` (Change 2)

Depends on Phase 1 to be useful.

1. Add `isNetworkError` helper to source connector
2. Update `errorToTrace` / `classifyError` in `src-list-api.ts`
3. Expand `PERMANENT_FAILURE_TYPES` to include `system_error`
4. Update tests

### Phase 4: Recovery signals (additive)

1. Define new signals in `_shared.ts`
2. Add handlers in `pipelineWorkflow`
3. Wire to service API endpoints

### Migration

Phase 1 (activity behavior change) ships without workflow versioning concerns — the activity return type already includes `errors`, the change is just removing the throw path. The workflow already handles `result.errors` for the permanent case; extending it to handle transient errors is additive.

Phase 3 (reclassifying `system_error` as permanent) changes behavior — errors that previously retried will now park. This is intentionally a stricter-by-default posture. Use `patched()` if in-flight workflows need the old behavior during rollout.

## Future work (out of scope)

- **Per-stream error isolation**: a single failing stream shouldn't block others (Airbyte `INCOMPLETE` model)
- **Circuit breaker**: when Stripe is down, stop hammering the API; probe periodically
- **Error detail persistence**: write error details to pipeline store for API/UI consumption

## Constants

```ts
const MAX_TRANSIENT_RETRIES = 5 // before escalating to permanent
```

## Open questions

1. **Should `system_error` get 1 retry before parking?** Some system errors might be flaky. One retry before escalation could be a reasonable middle ground.
2. **How does the operator know what to do?** When the workflow parks, it needs visibility into _why_ and _what action to take_. Should the workflow write error details to the pipeline store?
3. **Should `SKIPPABLE_ERROR_PATTERNS` move to the workflow layer?** Currently the source connector silently swallows these. If the workflow handled all error classification, the source would just emit errors and let the orchestrator decide. Cleaner separation, but requires the workflow to understand Stripe-specific error messages.
4. **Backward compatibility.** Changing activity return types is a Temporal versioning concern. Existing in-flight workflows expect the throw behavior for transient errors.
