import type { SourceInputMessage, SourceReadOptions } from '@stripe/sync-engine'
import type { ActivitiesContext } from './_shared.js'
import { asIterable, drainMessages, type RunResult } from './_shared.js'

export function createPipelineSyncActivity(context: ActivitiesContext) {
  return async function pipelineSync(
    pipelineId: string,
    opts?: SourceReadOptions & { input?: SourceInputMessage[] }
  ): Promise<RunResult & { eof?: { reason: string } }> {
    const pipeline = await context.pipelineStore.get(pipelineId)
    const { id: _, ...config } = pipeline
    const { input: inputArr, ...readOpts } = opts ?? {}
    const input = inputArr?.length ? asIterable(inputArr) : undefined
    const { errors, state, sourceConfig, destConfig, eof } = await drainMessages(
      context.engine.pipeline_sync(config, readOpts, input),
      readOpts.state
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
    return { errors, state, eof }
  }
}
