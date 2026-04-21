import type { EofPayload, SyncState } from '@stripe/sync-protocol'
import type { SyncActivities } from '../activities/index.js'

export interface BackfillLoopOpts {
  syncState: SyncState
  syncRunId: string
  timeLimit?: number
}

/**
 * Run a single backfill step: call pipelineSync once and return the result.
 * Caller decides whether to loop (direct mode) or continueAsNew (Temporal).
 */
export async function backfillStep(
  activities: Pick<SyncActivities, 'pipelineSync'>,
  pipelineId: string,
  opts: BackfillLoopOpts
): Promise<{ eof: EofPayload; syncState: SyncState }> {
  const { eof } = await activities.pipelineSync(pipelineId, {
    state: opts.syncState,
    time_limit: opts.timeLimit ?? 30,
    run_id: opts.syncRunId,
  })
  const syncState = eof.ending_state ?? opts.syncState
  return { eof, syncState }
}

/**
 * Run backfill to completion without Temporal (no continueAsNew, no history limits).
 * Loops backfillStep until has_more=false.
 */
export async function runBackfillToCompletion(
  activities: Pick<SyncActivities, 'pipelineSync'>,
  pipelineId: string,
  opts: BackfillLoopOpts
): Promise<{ eof: EofPayload; syncState: SyncState }> {
  let syncState = opts.syncState
  while (true) {
    const result = await backfillStep(activities, pipelineId, { ...opts, syncState })
    syncState = result.syncState
    if (!result.eof.has_more) return result
  }
}
