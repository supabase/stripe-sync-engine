import { condition, continueAsNew, setHandler } from '@temporalio/workflow'

import {
  deleteSignal,
  stateQuery,
  statusQuery,
  syncImmediate,
  updateSignal,
  WorkflowStatus,
} from './_shared.js'
import type { SourceState } from '@stripe/sync-protocol'
import { CONTINUE_AS_NEW_THRESHOLD } from '../../lib/utils.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface BackfillPipelineWorkflowOpts {
  state?: SourceState
  reconcileComplete?: boolean
}

export async function backfillPipelineWorkflow(
  pipelineId: string,
  opts?: BackfillPipelineWorkflowOpts
): Promise<void> {
  let paused = false
  let deleted = false
  let iteration = 0
  let syncState: SourceState = opts?.state ?? { streams: {}, global: {} }
  let reconcileComplete: boolean = opts?.reconcileComplete ?? false

  setHandler(updateSignal, (patch) => {
    if (patch.paused !== undefined) paused = patch.paused
  })
  setHandler(deleteSignal, () => {
    deleted = true
  })

  setHandler(statusQuery, (): WorkflowStatus => ({ phase: 'running', paused, iteration }))
  setHandler(stateQuery, (): SourceState => syncState)

  async function maybeContinueAsNew() {
    if (++iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof backfillPipelineWorkflow>(pipelineId, {
        state: syncState,
        reconcileComplete,
      })
    }
  }

  while (!deleted) {
    if (paused) {
      await condition(() => !paused || deleted)
      continue
    }

    if (reconcileComplete) {
      // Idle — wait up to one week; timeout means recon is due.
      const timedOut = !(await condition(() => paused || deleted, ONE_WEEK_MS))
      if (timedOut) reconcileComplete = false
      continue
    }

    const result = await syncImmediate(pipelineId, {
      state: syncState,
      state_limit: 100,
      time_limit: 10,
    })
    syncState = result.state
    reconcileComplete = result.eof?.reason === 'complete'
    await maybeContinueAsNew()
  }
}
