import { createRemoteEngine } from '@stripe/sync-engine'
import type { PipelineConfig, SourceReadOptions } from '@stripe/sync-engine'
import type { ActivitiesContext } from './_shared.js'
import { asIterable, drainMessages, type RunResult } from './_shared.js'

export function createSyncImmediateActivity(context: ActivitiesContext) {
  return async function syncImmediate(
    config: PipelineConfig,
    opts?: SourceReadOptions & { input?: unknown[] }
  ): Promise<RunResult & { eof?: { reason: string } }> {
    const engine = createRemoteEngine(context.engineUrl)
    const { input: inputArr, ...syncOpts } = opts ?? {}
    const input = inputArr?.length ? asIterable(inputArr) : undefined
    const { errors, state, eof } = await drainMessages(
      engine.pipeline_sync(config, syncOpts, input) as AsyncIterable<Record<string, unknown>>
    )
    return { errors, state, eof }
  }
}
