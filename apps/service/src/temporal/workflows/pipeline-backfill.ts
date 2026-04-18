import { ApplicationFailure, continueAsNew } from '@temporalio/workflow'

import type { EofPayload, SyncState } from '@stripe/sync-protocol'
import { pipelineSync } from './_shared.js'
import type { SyncRunError } from '../sync-errors.js'

export interface PipelineBackfillOpts {
  syncState: SyncState
}

export interface PipelineBackfillResult {
  eof: EofPayload
  errors: SyncRunError[]
}

const BACKFILL_CONTINUE_AS_NEW_THRESHOLD = 200

/**
 * Child workflow that runs a backfill from start to finish.
 * Calls pipelineSync in a loop until has_more=false, then returns.
 * On permanent errors, the workflow fails (throws).
 */
export async function pipelineBackfill(
  pipelineId: string,
  opts: PipelineBackfillOpts
): Promise<PipelineBackfillResult> {
  let syncState = opts.syncState
  let operationCount = 0

  while (true) {
    const result = await pipelineSync(pipelineId, {
      state: syncState,
      state_limit: 100,
      time_limit: 10,
    })
    operationCount++

    if (result.state) {
      syncState = result.state
    }

    if (result.errors.length > 0) {
      const summary = result.errors.map((e) => e.message).join('; ')
      throw ApplicationFailure.nonRetryable(summary, 'PermanentSyncError')
    }

    if (!result.eof?.has_more) {
      return {
        eof: result.eof ?? { reason: 'complete', has_more: false, state: syncState },
        errors: result.errors,
      }
    }

    if (operationCount >= BACKFILL_CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof pipelineBackfill>(pipelineId, { syncState })
    }
  }
}
