import { enforceCatalog } from '@stripe/sync-engine'
import type {
  ConfiguredCatalog,
  DestinationInput,
  Message,
  RecordMessage,
} from '@stripe/sync-engine'
import {
  configSchema as googleSheetsConfigSchema,
  createDestination as createGoogleSheetsDestination,
  parseGoogleSheetsMetaLog,
  ROW_KEY_FIELD,
  ROW_NUMBER_FIELD,
  serializeRowKey,
} from '@stripe/sync-destination-google-sheets'

import type { ActivitiesContext } from './_shared.js'
import { asIterable, collectError, mergeStateMessage, type RunResult } from './_shared.js'

type RowIndexMap = Record<string, Record<string, number>>

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

function withRowNumber(record: RecordMessage, rowIndexMap: RowIndexMap): RecordMessage {
  const rowKey =
    typeof record.record.data[ROW_KEY_FIELD] === 'string'
      ? record.record.data[ROW_KEY_FIELD]
      : undefined
  const rowNumber = rowKey ? rowIndexMap[record.record.stream]?.[rowKey] : undefined
  if (rowNumber === undefined) return record
  return {
    ...record,
    record: {
      ...record.record,
      data: { ...record.record.data, [ROW_NUMBER_FIELD]: rowNumber },
    },
  }
}

function compactGoogleSheetsMessages(messages: Message[]): Message[] {
  const compacted: Message[] = []
  let pendingOrder: string[] = []
  let pending = new Map<string, RecordMessage>()

  const flushPending = () => {
    for (const key of pendingOrder) {
      const message = pending.get(key)
      if (message) compacted.push(message)
    }
    pendingOrder = []
    pending = new Map()
  }

  for (const message of messages) {
    if (message.type === 'record') {
      const rowKey =
        typeof message.record.data[ROW_KEY_FIELD] === 'string'
          ? message.record.data[ROW_KEY_FIELD]
          : undefined
      if (!rowKey) {
        compacted.push(message)
        continue
      }
      const dedupeKey = `${message.record.stream}:${rowKey}`
      if (!pending.has(dedupeKey)) pendingOrder.push(dedupeKey)
      pending.set(dedupeKey, message)
      continue
    }

    if (message.type === 'source_state') {
      flushPending()
      compacted.push(message)
    }
  }

  flushPending()
  return compacted
}

function augmentGoogleSheetsCatalog(catalog: ConfiguredCatalog): ConfiguredCatalog {
  return {
    streams: catalog.streams.map((configuredStream) => {
      const props = configuredStream.stream.json_schema?.properties as
        | Record<string, unknown>
        | undefined

      if (!props) return configuredStream

      return {
        ...configuredStream,
        stream: {
          ...configuredStream.stream,
          json_schema: {
            ...configuredStream.stream.json_schema,
            properties: {
              ...props,
              [ROW_KEY_FIELD]: { type: 'string' },
              [ROW_NUMBER_FIELD]: { type: 'number' },
            },
          },
        },
      }
    }),
  }
}

export function createWriteGoogleSheetsFromQueueActivity(context: ActivitiesContext) {
  return async function writeGoogleSheetsFromQueue(
    pipelineId: string,
    opts?: {
      maxBatch?: number
      catalog?: ConfiguredCatalog
      rowIndexMap?: RowIndexMap
      sourceState?: import('@stripe/sync-engine').SourceState
    }
  ): Promise<
    RunResult & {
      written: number
      rowIndexMap: Record<string, Record<string, number>>
    }
  > {
    if (!context.kafkaBroker) throw new Error('kafkaBroker is required for Google Sheets workflow')

    const maxBatch = opts?.maxBatch ?? 50
    const queued = await context.consumeQueueBatch(pipelineId, maxBatch)

    let sourceState: import('@stripe/sync-engine').SourceState = opts?.sourceState ?? {
      streams: {},
      global: {},
    }

    if (queued.length === 0) {
      return { errors: [], state: sourceState, written: 0, rowIndexMap: {} }
    }

    const pipeline = await context.pipelineStore.get(pipelineId)
    const { id: _, ...config } = pipeline
    const augmented = queued.map((message) => {
      if (message.type !== 'record') return message
      const keyed = withRowKey(message, opts?.catalog)
      return opts?.rowIndexMap ? withRowNumber(keyed, opts.rowIndexMap) : keyed
    })
    const writeBatch = compactGoogleSheetsMessages(augmented)
    if (config.destination.type !== 'google_sheets') {
      throw new Error('writeGoogleSheetsFromQueue requires a google_sheets destination')
    }
    if (!opts?.catalog) {
      throw new Error('catalog is required for Google Sheets workflow writes')
    }

    const destinationConfig = googleSheetsConfigSchema.parse(config.destination)
    const filteredCatalog = augmentGoogleSheetsCatalog(opts.catalog)
    const destination = createGoogleSheetsDestination()
    const errors: RunResult['errors'] = []
    const rowIndexMap: Record<string, Record<string, number>> = {}
    const input = enforceCatalog(filteredCatalog)(
      asIterable(writeBatch)
    ) as AsyncIterable<DestinationInput>

    for await (const raw of destination.write(
      {
        config: destinationConfig,
        catalog: filteredCatalog,
      },
      input
    )) {
      const error = collectError(raw)
      if (error) {
        errors.push(error)
      } else if (raw.type === 'source_state') {
        sourceState = mergeStateMessage(sourceState, raw)
      } else if (raw.type === 'log') {
        const meta = parseGoogleSheetsMetaLog(raw.log.message)
        if (meta?.type === 'row_assignments') {
          for (const [stream, assignments] of Object.entries(meta.assignments)) {
            rowIndexMap[stream] ??= {}
            Object.assign(rowIndexMap[stream], assignments)
          }
        }
      }
    }

    return { errors, state: sourceState, written: queued.length, rowIndexMap }
  }
}
