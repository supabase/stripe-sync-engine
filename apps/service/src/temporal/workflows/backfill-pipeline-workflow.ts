import { condition, continueAsNew, setHandler } from '@temporalio/workflow'

import {
  configQuery,
  deleteSignal,
  Pipeline,
  stateQuery,
  statusQuery,
  syncImmediate,
  toConfig,
  updateSignal,
  WorkflowStatus,
} from './_shared.js'
import { CONTINUE_AS_NEW_THRESHOLD } from '../../lib/utils.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface BackfillPipelineWorkflowOpts {
  state?: Record<string, unknown>
}

export async function backfillPipelineWorkflow(
  pipeline: Pipeline,
  opts?: BackfillPipelineWorkflowOpts
): Promise<void> {
  let paused = false
  let deleted = false
  let iteration = 0
  let syncState: Record<string, unknown> = opts?.state ?? {}
  let backfillComplete = false

  setHandler(updateSignal, (patch: Partial<Pipeline>) => {
    if (patch.source) pipeline = { ...pipeline, source: patch.source }
    if (patch.destination) pipeline = { ...pipeline, destination: patch.destination }
    if (patch.streams !== undefined) pipeline = { ...pipeline, streams: patch.streams }
    if ('paused' in (patch as Record<string, unknown>)) {
      paused = !!(patch as Record<string, unknown>).paused
    }
  })
  setHandler(deleteSignal, () => {
    deleted = true
  })

  setHandler(statusQuery, (): WorkflowStatus => ({ phase: 'running', paused, iteration }))
  setHandler(configQuery, (): Pipeline => pipeline)
  setHandler(stateQuery, (): Record<string, unknown> => syncState)

  async function maybeContinueAsNew() {
    if (++iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof backfillPipelineWorkflow>(pipeline, { state: syncState })
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

    const result = await syncImmediate(toConfig(pipeline), { state: syncState, stateLimit: 1 })
    syncState = { ...syncState, ...result.state }
    backfillComplete = result.eof?.reason === 'complete'
    await maybeContinueAsNew()
  }
}
