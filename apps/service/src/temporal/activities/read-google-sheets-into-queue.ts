import { heartbeat } from '@temporalio/activity'
import { createRemoteEngine } from '@stripe/sync-engine'
import type {
  ConfiguredCatalog,
  Message,
  PipelineConfig,
  RecordMessage,
  SourceReadOptions,
} from '@stripe/sync-engine'
import { ROW_KEY_FIELD, serializeRowKey } from '@stripe/sync-destination-google-sheets'
import type { ActivitiesContext } from './_shared.js'
import { asIterable, collectError, type RunResult } from './_shared.js'

function withRowKey(record: RecordMessage, catalog?: ConfiguredCatalog): RecordMessage {
  const primaryKey = catalog?.streams.find((stream) => stream.stream.name === record.record.stream)
    ?.stream.primary_key
  if (!primaryKey) return record
  return {
    ...record,
    record: {
      ...record.record,
      data: {
        ...record.record.data,
        [ROW_KEY_FIELD]: serializeRowKey(primaryKey, record.record.data),
      },
    },
  }
}

export function createReadGoogleSheetsIntoQueueActivity(context: ActivitiesContext) {
  return async function readGoogleSheetsIntoQueue(
    config: PipelineConfig,
    pipelineId: string,
    opts?: SourceReadOptions & {
      input?: unknown[]
      catalog?: ConfiguredCatalog
    }
  ): Promise<{ count: number; state: Record<string, unknown> }> {
    if (!context.kafkaBroker) throw new Error('kafkaBroker is required for Google Sheets workflow')

    const engine = createRemoteEngine(context.engineUrl)
    const { input: inputArr, catalog, ...syncOpts } = opts ?? {}
    const input = inputArr?.length ? asIterable(inputArr) : undefined

    const queued: Message[] = []
    const state: Record<string, unknown> = {}
    const errors: RunResult['errors'] = []
    let seen = 0

    for await (const raw of engine.pipeline_read(config, syncOpts, input) as AsyncIterable<
      Record<string, unknown>
    >) {
      seen++
      const error = collectError(raw)
      if (error) {
        errors.push(error)
      } else if (raw.type === 'record') {
        queued.push(withRowKey(raw as RecordMessage, catalog))
      } else if (raw.type === 'state') {
        const statePayload = (raw as Record<string, unknown>).state as Record<string, unknown>
        if (typeof statePayload?.stream === 'string') {
          state[statePayload.stream] = statePayload.data
        }
        queued.push(raw as Message)
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

    return { count: queued.length, state }
  }
}
