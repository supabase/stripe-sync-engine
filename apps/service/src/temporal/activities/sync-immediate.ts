import type { SourceReadOptions } from '@stripe/sync-engine'
import type { ActivitiesContext } from './_shared.js'
import { asIterable, drainMessages, type RunResult } from './_shared.js'

type SourceInput = unknown

export function createSyncImmediateActivity(context: ActivitiesContext) {
  return async function syncImmediate(
    pipelineId: string,
    opts?: SourceReadOptions & { input?: SourceInput[] }
  ): Promise<RunResult & { eof?: { reason: string } }> {
    const pipeline = await context.pipelineStore.get(pipelineId)
    const { id: _, ...config } = pipeline
    const { input: inputArr, ...readOpts } = opts ?? {}
    const input = inputArr?.length ? asIterable(inputArr) : undefined
    const { errors, state, controls, eof } = await drainMessages(
      context.engine.pipeline_sync(config, readOpts, input)
    )
    // Persist source config updates from control messages (e.g. OAuth token refresh)
    if (controls.length > 0) {
      const merged = controls.reduce((acc, c) => ({ ...acc, ...c }), {})
      await context.pipelineStore.update(pipelineId, {
        source: { ...pipeline.source, ...merged },
      })
    }
    return { errors, state, eof }
  }
}
