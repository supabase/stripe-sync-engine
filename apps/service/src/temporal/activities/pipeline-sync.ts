import { parseSyncState } from '@stripe/sync-engine'
import type { SourceInputMessage, SourceReadOptions } from '@stripe/sync-engine'
import type { EofPayload } from '@stripe/sync-protocol'
import type { ActivitiesContext } from './_shared.js'
import { asIterable, drainMessages } from './_shared.js'

export function createPipelineSyncActivity(context: ActivitiesContext) {
  return async function pipelineSync(
    pipelineId: string,
    opts?: SourceReadOptions & { input?: SourceInputMessage[] }
  ): Promise<{ eof: EofPayload }> {
    const pipeline = await context.pipelineStore.get(pipelineId)

    const { id: _, ...config } = pipeline
    const { input: inputArr, ...readOpts } = opts ?? {}
    const input = inputArr?.length ? asIterable(inputArr) : undefined

    // Destination-specific soft_time_limit defaults now live in the engine
    // (driven by spec.soft_limit_fraction). The activity just forwards readOpts.
    const initialState = parseSyncState(readOpts.state)
    const { sourceConfig, destConfig, eof } = await drainMessages(
      context.engine.pipeline_sync(config, readOpts, input),
      initialState
    )

    if (!eof) throw new Error('pipeline_sync ended without eof message')

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
    await context.pipelineStore.update(pipelineId, {
      sync_state: eof.ending_state,
    })

    return { eof }
  }
}
