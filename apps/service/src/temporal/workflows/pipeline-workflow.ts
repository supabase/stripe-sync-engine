import { condition, continueAsNew, setHandler } from '@temporalio/workflow'

import type { SourceInputMessage, SourceState } from '@stripe/sync-protocol'
import type { DesiredStatus, PipelineStatus } from '../../lib/createSchemas.js'
import { CONTINUE_AS_NEW_THRESHOLD } from '../../lib/utils.js'
import { classifySyncErrors } from '../sync-errors.js'
import {
  desiredStatusSignal,
  pipelineSetup,
  sourceInputSignal,
  pipelineSync,
  pipelineTeardown,
  updatePipelineStatus,
} from './_shared.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
const LIVE_EVENT_BATCH_SIZE = 10

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
  desiredStatus?: DesiredStatus
  sourceState?: SourceState
  inputQueue?: SourceInputMessage[]
  state?: PipelineWorkflowState
  errorRecoveryRequested?: boolean
}

export async function pipelineWorkflow(
  pipelineId: string,
  opts?: PipelineWorkflowOpts
): Promise<void> {
  // Persisted through continue-as-new.
  const inputQueue: SourceInputMessage[] = opts?.inputQueue ? [...opts.inputQueue] : []
  let desiredStatus: DesiredStatus = opts?.desiredStatus ?? 'active'
  let sourceState: SourceState = opts?.sourceState ?? { streams: {}, global: {} }
  let state: PipelineWorkflowState = { ...opts?.state }
  let errorRecoveryRequested = opts?.errorRecoveryRequested ?? false

  // Transient workflow-local state.
  let operationCount = 0

  setHandler(sourceInputSignal, (event: SourceInputMessage) => {
    inputQueue.push(event)
  })
  setHandler(desiredStatusSignal, (status: DesiredStatus) => {
    desiredStatus = status
    if (state.errored && status === 'active') {
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

  /**
   * Returns whether active work in this run should stop because the pipeline is
   * no longer active or because the workflow should roll over into continue-as-new.
   */
  function runInterrupted() {
    return (
      desiredStatus !== 'active' || operationCount >= CONTINUE_AS_NEW_THRESHOLD || !!state.errored
    )
  }

  async function markPermanentError(): Promise<void> {
    await setState({ errored: true })
  }

  async function waitForErrorRecovery(): Promise<void> {
    await condition(() => desiredStatus === 'deleted' || errorRecoveryRequested)
    errorRecoveryRequested = false
    if (desiredStatus === 'active') {
      await setState({ errored: false })
    }
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
      if (classifySyncErrors(result.errors).permanent.length > 0) {
        await markPermanentError()
        return
      }
    }
  }

  // MARK: - Reconcile loop

  async function waitForReconcileTurn(): Promise<boolean> {
    await condition(() => runInterrupted() || state.phase !== 'ready', ONE_WEEK_MS)

    if (runInterrupted()) {
      return false
    }

    return true
  }

  async function reconcileLoop(): Promise<void> {
    while (await waitForReconcileTurn()) {
      if (!state.phase) {
        await setState({ phase: 'backfilling' })
      } else if (state.phase === 'ready') {
        await setState({ phase: 'reconciling' })
      }

      const result = await pipelineSync(pipelineId, {
        state: sourceState,
        state_limit: 100,
        time_limit: 10,
      })
      operationCount++
      sourceState = result.state
      if (classifySyncErrors(result.errors).permanent.length > 0) {
        await markPermanentError()
        return
      }
      if (result.eof?.reason === 'complete' && !state.errored) {
        await setState({ phase: 'ready' })
      }
    }
  }

  // MARK: - Main logic

  if (state.setup !== 'completed') {
    await setState({ setup: 'started' })
    await pipelineSetup(pipelineId)
    await setState({ setup: 'completed' })
  }

  while (desiredStatus !== 'deleted') {
    if (state.errored) {
      await waitForErrorRecovery()
      continue
    }

    if (desiredStatus === 'paused') {
      await setState({ paused: true })
      await condition(() => desiredStatus !== 'paused')
      await setState({ paused: false })
      // Re-enter root control flow after pause in case the pipeline resumed
      // normally or was deleted while we were waiting.
      continue
    }

    await Promise.all([liveLoop(), reconcileLoop()])

    if (operationCount >= CONTINUE_AS_NEW_THRESHOLD) {
      return await continueAsNew<typeof pipelineWorkflow>(pipelineId, {
        desiredStatus,
        sourceState,
        inputQueue,
        state,
        errorRecoveryRequested,
      })
    }
  }

  // Delete stays in normal workflow control flow instead of cancellation so teardown
  // can run once in the terminal path after the active loops have stopped.
  await setState({ teardown: 'started' })
  await pipelineTeardown(pipelineId)
  await setState({ teardown: 'completed' })
}
