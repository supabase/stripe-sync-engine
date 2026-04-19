import { ApplicationFailure, continueAsNew } from '@temporalio/workflow'

import type { EofPayload, SyncState } from '@stripe/sync-protocol'
import { pipelineSync } from './_shared.js'

export interface PipelineBackfillOpts {
  syncState: SyncState
}

export interface PipelineBackfillResult {
  eof: EofPayload
}

const BACKFILL_CONTINUE_AS_NEW_THRESHOLD = 200

/**
 * Child workflow that runs a backfill from start to finish.
 * Calls pipelineSync in a loop until has_more=false, then returns the final eof.
 * The parent workflow inspects eof.run_progress.derived.status to decide next steps.
 */
export async function pipelineBackfill(
  pipelineId: string,
  opts: PipelineBackfillOpts
): Promise<PipelineBackfillResult> {
  let syncState = opts.syncState
  let operationCount = 0

  while (true) {
    const { eof } = await pipelineSync(pipelineId, {
      state: syncState,
      state_limit: 100,
      time_limit: 10,
    })
    operationCount++

    if (eof.ending_state) {
      syncState = eof.ending_state
    }

    if (!eof.has_more) {
      if (eof.run_progress.derived.status === 'failed') {
        const message = eof.run_progress.connection_status?.message ?? 'Sync failed'
        throw ApplicationFailure.nonRetryable(message, 'SyncFailed')
      }
      return { eof }
    }

    if (operationCount >= BACKFILL_CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof pipelineBackfill>(pipelineId, { syncState })
    }
  }
}
