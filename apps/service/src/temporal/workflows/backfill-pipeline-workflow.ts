import { condition, continueAsNew, setHandler } from '@temporalio/workflow'

import {
  deleteSignal,
  stateQuery,
  statusQuery,
  syncImmediate,
  updateSignal,
  WorkflowStatus,
} from './_shared.js'
import { CONTINUE_AS_NEW_THRESHOLD } from '../../lib/utils.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface BackfillPipelineWorkflowOpts {
  state?: Record<string, unknown>
}

export async function backfillPipelineWorkflow(
  pipelineId: string,
  opts?: BackfillPipelineWorkflowOpts
): Promise<void> {
  let paused = false
  let deleted = false
  let iteration = 0
  let syncState: Record<string, unknown> = opts?.state ?? {}
  let backfillComplete = false

  setHandler(updateSignal, (patch) => {
    if (patch.paused !== undefined) paused = patch.paused
  })
  setHandler(deleteSignal, () => {
    deleted = true
  })

  setHandler(statusQuery, (): WorkflowStatus => ({ phase: 'running', paused, iteration }))
  setHandler(stateQuery, (): Record<string, unknown> => syncState)

  async function maybeContinueAsNew() {
    if (++iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof backfillPipelineWorkflow>(pipelineId, { state: syncState })
    }
  }

  while (!deleted) {
    if (paused) {
      await condition(() => !paused || deleted)
      continue
    }

    if (backfillComplete) {
      // Idle — wait up to one week; timeout means recon is due.
      const timedOut = !(await condition(() => paused || deleted, ONE_WEEK_MS))
      if (timedOut) backfillComplete = false
      continue
    }

    const result = await syncImmediate(pipelineId, { state: syncState, state_limit: 1 })
    syncState = { ...syncState, ...result.state }
    backfillComplete = result.eof?.reason === 'complete'
    await maybeContinueAsNew()
  }
}
