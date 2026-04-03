import { createRemoteEngine } from '@stripe/sync-engine'
import type { Message, PipelineConfig } from '@stripe/sync-engine'
import type { ActivitiesContext } from './_shared.js'
import { asIterable, drainMessages, type RunResult } from './_shared.js'

export function createWriteFromQueueActivity(context: ActivitiesContext) {
  return async function writeFromQueue(
    config: PipelineConfig,
    pipelineId: string,
    opts?: { records?: unknown[]; maxBatch?: number }
  ): Promise<RunResult & { written: number }> {
    let records: unknown[]

    if (context.kafkaBroker) {
      const maxBatch = opts?.maxBatch ?? 50
      records = await context.consumeQueueBatch(pipelineId, maxBatch)
    } else {
      records = opts?.records ?? []
    }

    if (records.length === 0) {
      return { errors: [], state: {}, written: 0 }
    }

    const engine = createRemoteEngine(context.engineUrl)
    const { errors, state } = await drainMessages(
      engine.pipeline_write(config, asIterable(records) as AsyncIterable<Message>) as AsyncIterable<
        Record<string, unknown>
      >
    )

    return { errors, state, written: records.length }
  }
}
