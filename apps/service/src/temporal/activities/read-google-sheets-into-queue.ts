import { heartbeat } from '@temporalio/activity'
import type {
  ConfiguredCatalog,
  Message,
  RecordMessage,
  SourceInputMessage,
  SourceReadOptions,
} from '@stripe/sync-engine'
import {
  ROW_KEY_FIELD,
  ROW_NUMBER_FIELD,
  serializeRowKey,
} from '@stripe/sync-destination-google-sheets'

import type { ActivitiesContext } from './_shared.js'
import { asIterable, collectError, type RunResult } from './_shared.js'
type RowIndex = Record<string, Record<string, number>>

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

function withRowNumber(record: RecordMessage, rowIndex: RowIndex): RecordMessage {
  const rowKey =
    typeof record.record.data[ROW_KEY_FIELD] === 'string'
      ? record.record.data[ROW_KEY_FIELD]
      : undefined
  const rowNumber = rowKey ? rowIndex[record.record.stream]?.[rowKey] : undefined
  if (rowNumber === undefined) return record
  return {
    ...record,
    record: {
      ...record.record,
      data: { ...record.record.data, [ROW_NUMBER_FIELD]: rowNumber },
    },
  }
}

export function createReadGoogleSheetsIntoQueueActivity(context: ActivitiesContext) {
  return async function readGoogleSheetsIntoQueue(
    pipelineId: string,
    opts?: SourceReadOptions & {
      input?: SourceInputMessage[]
      catalog?: ConfiguredCatalog
      rowIndex?: RowIndex
    }
  ): Promise<{ count: number; state: import('@stripe/sync-engine').SourceState }> {
    if (!context.kafkaBroker) throw new Error('kafkaBroker is required for Google Sheets workflow')

    const pipeline = await context.pipelineStore.get(pipelineId)
    const { id: _, ...config } = pipeline
    const { input: inputArr, catalog, rowIndex, ...readOpts } = opts ?? {}
    const input = inputArr?.length ? asIterable(inputArr) : undefined

    const queued: Message[] = []
    const state: import('@stripe/sync-engine').SourceState = {
      streams: { ...readOpts.state?.streams },
      global: { ...readOpts.state?.global },
    }
    const errors: RunResult['errors'] = []
    let seen = 0

    for await (const raw of context.engine.pipeline_read(config, readOpts, input)) {
      seen++
      const error = collectError(raw)
      if (error) {
        errors.push(error)
      } else if (raw.type === 'record') {
        const withKey = withRowKey(raw, catalog)
        queued.push(rowIndex ? withRowNumber(withKey, rowIndex) : withKey)
      } else if (raw.type === 'source_state') {
        if (raw.source_state.state_type === 'global') {
          state.global = raw.source_state.data as Record<string, unknown>
        } else {
          state.streams[raw.source_state.stream] = raw.source_state.data
        }
        queued.push(raw)
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
