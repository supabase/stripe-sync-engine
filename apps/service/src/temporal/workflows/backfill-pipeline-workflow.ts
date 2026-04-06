import { condition, continueAsNew, setHandler } from '@temporalio/workflow'

import { desiredStatusSignal, pipelineSync, updatePipelineStatus } from './_shared.js'
import type { SourceState as SyncState } from '@stripe/sync-protocol'
import { CONTINUE_AS_NEW_THRESHOLD } from '../../lib/utils.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface BackfillPipelineWorkflowOpts {
  desiredStatus?: string
  state?: SyncState
}

export async function backfillPipelineWorkflow(
  pipelineId: string,
  opts?: BackfillPipelineWorkflowOpts
): Promise<void> {
  let desiredStatus = opts?.desiredStatus ?? 'active'
  let iteration = 0
  let syncState: SyncState = opts?.state ?? { streams: {}, global: {} }
  let backfillComplete = false

  setHandler(desiredStatusSignal, (status: string) => {
    desiredStatus = status
  })

  async function maybeContinueAsNew() {
    if (++iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof backfillPipelineWorkflow>(pipelineId, {
        desiredStatus,
        state: syncState,
      })
    }
  }

  await updatePipelineStatus(pipelineId, 'backfill')

  while (desiredStatus !== 'deleted') {
    if (desiredStatus === 'paused') {
      await updatePipelineStatus(pipelineId, 'paused')
      await condition(() => desiredStatus !== 'paused')
      continue
    }

    if (backfillComplete) {
      await updatePipelineStatus(pipelineId, 'ready')
      const timedOut = !(await condition(() => desiredStatus !== 'active', ONE_WEEK_MS))
      if (timedOut) backfillComplete = false
      continue
    }

    const result = await pipelineSync(pipelineId, {
      state: syncState,
      state_limit: 100,
      time_limit: 10,
    })
    syncState = {
      streams: { ...syncState.streams, ...result.state.streams },
      global: { ...syncState.global, ...result.state.global },
    }
    backfillComplete = result.eof?.reason === 'complete'
    await maybeContinueAsNew()
  }

  await updatePipelineStatus(pipelineId, 'teardown')
}
