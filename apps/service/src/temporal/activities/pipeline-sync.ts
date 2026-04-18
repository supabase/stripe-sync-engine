import { ApplicationFailure } from '@temporalio/activity'
import { parseSyncState } from '@stripe/sync-engine'
import type { SourceInputMessage, SourceReadOptions } from '@stripe/sync-engine'
import type { EofPayload } from '@stripe/sync-protocol'
import type { ActivitiesContext } from './_shared.js'
import { asIterable, drainMessages, type RunResult } from './_shared.js'
import { classifySyncErrors, summarizeSyncErrors } from '../sync-errors.js'

export function createPipelineSyncActivity(context: ActivitiesContext) {
  return async function pipelineSync(
    pipelineId: string,
    opts?: SourceReadOptions & { input?: SourceInputMessage[] }
  ): Promise<RunResult & { eof?: EofPayload }> {
    const pipeline = await context.pipelineStore.get(pipelineId)
    const { id: _, ...config } = pipeline
    const { input: inputArr, ...readOpts } = opts ?? {}
    const input = inputArr?.length ? asIterable(inputArr) : undefined
    const initialState = parseSyncState(readOpts.state)
    const { errors, state, sourceConfig, destConfig, eof } = await drainMessages(
      context.engine.pipeline_sync(config, readOpts, input),
      initialState
    )
    // Full replacement — connector emits the complete updated config
    if (sourceConfig) {
      const type = pipeline.source.type
      await context.pipelineStore.update(pipelineId, {
        source: { type, [type]: sourceConfig },
      })
    }
    if (destConfig) {
      const type = pipeline.destination.type
      await context.pipelineStore.update(pipelineId, {
        destination: { type, [type]: destConfig },
      })
    }
    if (eof) {
      await context.pipelineStore.update(pipelineId, {
        progress: eof,
      })
    }
    const { transient, permanent } = classifySyncErrors(errors)
    if (permanent.length > 0) {
      if (transient.length > 0) {
        console.warn(
          `Transient errors suppressed by permanent failures: ${summarizeSyncErrors(transient)}`
        )
      }
      return { errors, state, eof }
    }
    if (transient.length > 0) {
      throw ApplicationFailure.retryable(summarizeSyncErrors(transient), 'TransientSyncError')
    }
    return { errors, state, eof }
  }
}
