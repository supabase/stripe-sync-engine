import { heartbeat } from '@temporalio/activity'
import type { Message, SourceInputMessage, SourceReadOptions } from '@stripe/sync-engine'
import type { EofPayload } from '@stripe/sync-protocol'

import type { ActivitiesContext } from './_shared.js'
import { mergeStateMessage, asIterable, collectError, type RunResult } from './_shared.js'

export function createReadIntoQueueActivity(context: ActivitiesContext) {
  return async function readIntoQueue(
    pipelineId: string,
    opts?: SourceReadOptions & { input?: SourceInputMessage[] }
  ): Promise<{
    count: number
    state: import('@stripe/sync-engine').SourceState
    eof?: EofPayload
  }> {
    if (!context.kafkaBroker) throw new Error('kafkaBroker is required for Google Sheets workflow')

    const pipeline = await context.pipelineStore.get(pipelineId)
    const { id: _, ...config } = pipeline
    const { input: inputArr, ...readOpts } = opts ?? {}
    const input = inputArr?.length ? asIterable(inputArr) : undefined

    const queued: Message[] = []
    let state: import('@stripe/sync-engine').SourceState = readOpts.state ?? {
      streams: {},
      global: {},
    }
    const errors: RunResult['errors'] = []
    let eof: EofPayload | undefined
    let seen = 0

    for await (const raw of context.engine.pipeline_read(config, readOpts, input)) {
      seen++
      if (raw.type === 'eof') {
        eof = { reason: raw.eof.reason, record_count: raw.eof.record_count }
      } else {
        const error = collectError(raw)
        if (error) {
          errors.push(error)
        } else if (raw.type === 'record') {
          queued.push(raw)
        } else if (raw.type === 'source_state') {
          state = mergeStateMessage(state, raw)
          queued.push(raw)
        }
      }
      if (seen % 50 === 0) heartbeat({ messages: seen })
    }
    if (seen % 50 !== 0) heartbeat({ messages: seen })

    if (errors.length > 0) {
      throw new Error(errors.map((error) => error.message).join('; '))
    }

    if (queued.length > 0) {
      const producer = await context.getProducer()
      await producer.send({
        topic: `pipeline.${pipelineId}`,
        messages: queued.map((message) => ({ value: JSON.stringify(message) })),
      })
    }

    return { count: queued.length, state, eof }
  }
}
