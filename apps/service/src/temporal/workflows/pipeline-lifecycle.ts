import {
  CancellationScope,
  condition,
  continueAsNew,
  executeChild,
  isCancellation,
  setHandler,
} from '@temporalio/workflow'

import type { SourceInputMessage, SyncState, SectionState } from '@stripe/sync-protocol'
import { emptySyncState } from '@stripe/sync-protocol'
import type { PipelineStatus } from '../../lib/createSchemas.js'
import {
  pausedSignal,
  pipelineSetup,
  sourceInputSignal,
  pipelineSync,
  pipelineTeardown,
  updatePipelineStatus,
} from './_shared.js'
import { pipelineBackfill } from './pipeline-backfill.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
const LIVE_EVENT_BATCH_SIZE = 10
const PIPELINE_CONTINUE_AS_NEW_THRESHOLD = 1000

export type ReconcileState = 'backfilling' | 'reconciling' | 'ready'
export type SetupState = 'started' | 'completed'
export type TeardownState = 'started' | 'completed'

export interface PipelineWorkflowState {
  phase?: ReconcileState
  paused?: boolean
  errored?: boolean
  setup?: SetupState
  teardown?: TeardownState
}

export interface PipelineWorkflowOpts {
  syncState?: SyncState
  /** @deprecated Use syncState. Kept for backward compat with in-flight continueAsNew payloads. */
  sourceState?: SectionState
  inputQueue?: SourceInputMessage[]
  state?: PipelineWorkflowState
  paused?: boolean
  errorRecoveryRequested?: boolean
}

function resolveSyncState(opts?: PipelineWorkflowOpts): SyncState {
  if (opts?.syncState) return opts.syncState
  if (opts?.sourceState) {
    return { ...emptySyncState(), source: opts.sourceState }
  }
  return emptySyncState()
}

export async function pipelineWorkflow(
  pipelineId: string,
  opts?: PipelineWorkflowOpts
): Promise<void> {
  // Persisted through continue-as-new.
  const inputQueue: SourceInputMessage[] = opts?.inputQueue ? [...opts.inputQueue] : []
  let paused = opts?.paused ?? false
  let syncState: SyncState = resolveSyncState(opts)
  let state: PipelineWorkflowState = { ...opts?.state }
  let errorRecoveryRequested = opts?.errorRecoveryRequested ?? false

  // Transient workflow-local state.
  let operationCount = 0

  setHandler(sourceInputSignal, (event: SourceInputMessage) => {
    inputQueue.push(event)
  })
  setHandler(pausedSignal, (value: boolean) => {
    paused = value
    if (state.errored && !value) {
      errorRecoveryRequested = true
    }
  })

  // MARK: - State

  function derivePipelineStatus(): PipelineStatus {
    if (state.teardown) return 'teardown'
    if (state.errored) return 'error'
    if (state.paused) return 'paused'
    if (state.setup !== 'completed') return 'setup'
    return state.phase === 'ready' ? 'ready' : 'backfill'
  }

  async function setState(next: Partial<PipelineWorkflowState>) {
    const previousStatus = derivePipelineStatus()
    state = { ...state, ...next }
    const nextStatus = derivePipelineStatus()

    if (previousStatus !== nextStatus) {
      await updatePipelineStatus(pipelineId, nextStatus)
    }
  }

  function runInterrupted() {
    return paused || operationCount >= PIPELINE_CONTINUE_AS_NEW_THRESHOLD || !!state.errored
  }

  async function markPermanentError(): Promise<void> {
    await setState({ errored: true })
  }

  async function waitForErrorRecovery(): Promise<void> {
    await condition(() => errorRecoveryRequested)
    errorRecoveryRequested = false
    await setState({ errored: false })
  }

  // MARK: - Live loop

  async function waitForLiveEvents(): Promise<SourceInputMessage[] | null> {
    await condition(() => inputQueue.length > 0 || runInterrupted())

    if (runInterrupted()) {
      return null
    }

    return inputQueue.splice(0, LIVE_EVENT_BATCH_SIZE)
  }

  async function liveLoop(): Promise<void> {
    while (true) {
      const events = await waitForLiveEvents()
      if (!events) return

      const result = await pipelineSync(pipelineId, { input: events })
      operationCount++
      if (result.errors.length > 0) {
        await markPermanentError()
        return
      }
    }
  }

  // MARK: - Backfill (child workflow)

  async function runBackfill(workflowId: string): Promise<boolean> {
    try {
      const result = await executeChild(pipelineBackfill, {
        workflowId,
        args: [pipelineId, { syncState }],
      })
      operationCount++
      syncState = result.eof.state ?? syncState
      return true
    } catch (err) {
      if (isCancellation(err)) throw err
      await markPermanentError()
      return false
    }
  }

  async function reconcileScheduler(): Promise<void> {
    while (!runInterrupted()) {
      await condition(() => runInterrupted(), ONE_WEEK_MS)
      if (runInterrupted()) return

      await setState({ phase: 'reconciling' })
      const ok = await runBackfill(`reconcile-${pipelineId}-${Date.now()}`)
      if (!ok) return
      await setState({ phase: 'ready' })
    }
  }

  // MARK: - Main logic

  try {
    if (state.setup !== 'completed') {
      await setState({ setup: 'started' })
      await pipelineSetup(pipelineId)
      await setState({ setup: 'completed' })
    }

    // Initial backfill
    if (state.phase !== 'ready') {
      await setState({ phase: 'backfilling' })
      const ok = await runBackfill(`backfill-${pipelineId}`)
      if (ok) {
        await setState({ phase: 'ready' })
      }
    }

    // Main loop — runs until cancelled or continueAsNew threshold
    while (true) {
      if (state.errored) {
        await waitForErrorRecovery()
        continue
      }

      if (paused) {
        await setState({ paused: true })
        await condition(() => !paused)
        await setState({ paused: false })
        continue
      }

      await Promise.all([liveLoop(), reconcileScheduler()])

      if (operationCount >= PIPELINE_CONTINUE_AS_NEW_THRESHOLD) {
        return await continueAsNew<typeof pipelineWorkflow>(pipelineId, {
          syncState,
          inputQueue,
          state,
          paused,
          errorRecoveryRequested,
        })
      }
    }
  } catch (err) {
    if (!isCancellation(err)) throw err

    // Cancellation = delete. Run teardown in a non-cancellable scope.
    await CancellationScope.nonCancellable(async () => {
      await setState({ teardown: 'started' })
      await pipelineTeardown(pipelineId)
      await setState({ teardown: 'completed' })
    })
  }
}
