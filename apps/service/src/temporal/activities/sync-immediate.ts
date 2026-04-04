import { createRemoteEngine } from '@stripe/sync-engine'
import type { SourceReadOptions } from '@stripe/sync-engine'
import { toConfig } from '../../lib/stores.js'
import type { ActivitiesContext } from './_shared.js'
import { asIterable, drainMessages, type RunResult } from './_shared.js'

export function createSyncImmediateActivity(context: ActivitiesContext) {
  return async function syncImmediate(
    pipelineId: string,
    opts?: SourceReadOptions & { input?: unknown[] }
  ): Promise<RunResult & { eof?: { reason: string } }> {
    const pipeline = await context.pipelines.get(pipelineId)
    const config = toConfig(pipeline)
    const engine = createRemoteEngine(context.engineUrl)
    const { input: inputArr, ...syncOpts } = opts ?? {}
    const input = inputArr?.length ? asIterable(inputArr) : undefined
    const { errors, state, eof } = await drainMessages(
      engine.pipeline_sync(config, syncOpts, input) as AsyncIterable<Record<string, unknown>>
    )
    return { errors, state, eof }
  }
}
