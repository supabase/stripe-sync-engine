import { createRemoteEngine } from '@stripe/sync-engine'
import type { PipelineConfig, SourceReadOptions } from '@stripe/sync-engine'
import type { ActivitiesContext } from './_shared.js'
import { asIterable, drainMessages } from './_shared.js'

export function createReadIntoQueueActivity(context: ActivitiesContext) {
  return async function readIntoQueue(
    config: PipelineConfig,
    pipelineId: string,
    opts?: SourceReadOptions & { input?: unknown[] }
  ): Promise<{ count: number; state: Record<string, unknown>; eof?: { reason: string } }> {
    const engine = createRemoteEngine(context.engineUrl)
    const { input: inputArr, ...syncOpts } = opts ?? {}
    const input = inputArr?.length ? asIterable(inputArr) : undefined
    const { records, state, eof } = await drainMessages(
      engine.pipeline_read(config, syncOpts, input) as AsyncIterable<Record<string, unknown>>
    )

    if (context.kafkaBroker && records.length > 0) {
      const producer = await context.getProducer()
      await producer.send({
        topic: `pipeline.${pipelineId}`,
        messages: records.map((record) => ({ value: JSON.stringify(record) })),
      })
    }

    return { count: records.length, state, eof }
  }
}
