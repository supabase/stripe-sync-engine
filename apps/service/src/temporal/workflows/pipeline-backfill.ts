import { ApplicationFailure, continueAsNew, workflowInfo } from '@temporalio/workflow'

import type { EofPayload, SyncState } from '@stripe/sync-protocol'
import { pipelineSync } from './_shared.js'
import { backfillStep } from '../lib/backfill-loop.js'

export interface PipelineBackfillOpts {
  syncState: SyncState
}

export interface PipelineBackfillResult {
  eof: EofPayload
}

const BACKFILL_CONTINUE_AS_NEW_THRESHOLD = 200

// DEBUG: hard cap on activity iterations per workflow. Remove once the
// sheets-destination looping bug is resolved.
const DEBUG_MAX_OPERATIONS = 100

/**
 * Child workflow that runs a backfill from start to finish.
 * Calls pipelineSync in a loop until has_more=false, then returns the final eof.
 * The parent workflow inspects eof.run_progress.derived.status to decide next steps.
 *
 * Uses workflowInfo().runId as the run_id so the engine tracks progress
 * across continueAsNew boundaries within the same Temporal run.
 */
export async function pipelineBackfill(
  pipelineId: string,
  opts: PipelineBackfillOpts
): Promise<PipelineBackfillResult> {
  const syncRunId = workflowInfo().runId
  let syncState = opts.syncState
  let operationCount = 0

  while (true) {
    const result = await backfillStep({ pipelineSync }, pipelineId, {
      syncState,
      syncRunId,
      stateLimit: 100,
      timeLimit: 30,
    })
    syncState = result.syncState
    operationCount++

    if (!result.eof.has_more) {
      if (result.eof.run_progress.derived.status === 'failed') {
        const message = result.eof.run_progress.connection_status?.message ?? 'Sync failed'
        throw ApplicationFailure.nonRetryable(message, 'SyncFailed')
      }
      return { eof: result.eof }
    }

    if (operationCount >= DEBUG_MAX_OPERATIONS) {
      log.warn('DEBUG_MAX_OPERATIONS reached — stopping backfill early', {
        pipelineId,
        operationCount,
        has_more: eof.has_more,
      })
      return { eof }
    }

    if (operationCount >= BACKFILL_CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof pipelineBackfill>(pipelineId, { syncState })
    }
  }
}
