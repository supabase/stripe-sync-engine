import type { SourceReadOptions } from '@stripe/sync-engine'
import type { ActivitiesContext } from './_shared.js'

type SourceInput = unknown
import { asIterable, drainMessages } from './_shared.js'

export function createReadIntoQueueActivity(context: ActivitiesContext) {
  return async function readIntoQueue(
    pipelineId: string,
    opts?: SourceReadOptions & { input?: SourceInput[] }
  ): Promise<{ count: number; state: Record<string, unknown>; eof?: { reason: string } }> {
    const pipeline = await context.pipelineStore.get(pipelineId)
    const { id: _, ...config } = pipeline
    const { input: inputArr, ...readOpts } = opts ?? {}
    const input = inputArr?.length ? asIterable(inputArr) : undefined
    const { records, state, eof } = await drainMessages(
      context.engine.pipeline_read(config, readOpts, input)
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
