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
} from '@stripe/sync-destination-google-sheets'

import type { ActivitiesContext } from './_shared.js'
import { asIterable, collectError, type RunResult } from './_shared.js'

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
      state?: import('@stripe/sync-engine').SourceState
    }
  ): Promise<
    RunResult & {
      written: number
      rowAssignments: Record<string, Record<string, number>>
    }
  > {
    if (!context.kafkaBroker) throw new Error('kafkaBroker is required for Google Sheets workflow')

    const maxBatch = opts?.maxBatch ?? 50
    const queued = await context.consumeQueueBatch(pipelineId, maxBatch)

    const initialState: import('@stripe/sync-engine').SourceState = {
      streams: { ...opts?.state?.streams },
      global: { ...opts?.state?.global },
    }

    if (queued.length === 0) {
      return { errors: [], state: initialState, written: 0, rowAssignments: {} }
    }

    const pipeline = await context.pipelineStore.get(pipelineId)
    const { id: _, ...config } = pipeline
    const writeBatch = compactGoogleSheetsMessages(queued)
    if (config.destination.type !== 'google-sheets') {
      throw new Error('writeGoogleSheetsFromQueue requires a google-sheets destination')
    }
    if (!opts?.catalog) {
      throw new Error('catalog is required for Google Sheets workflow writes')
    }

    const destinationConfig = googleSheetsConfigSchema.parse(config.destination)
    const filteredCatalog = augmentGoogleSheetsCatalog(opts.catalog)
    const destination = createGoogleSheetsDestination()
    const errors: RunResult['errors'] = []
    const state: import('@stripe/sync-engine').SourceState = {
      streams: { ...initialState.streams },
      global: { ...initialState.global },
    }
    const rowAssignments: Record<string, Record<string, number>> = {}
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
        if (raw.source_state.state_type === 'global') {
          state.global = raw.source_state.data as Record<string, unknown>
        } else {
          state.streams[raw.source_state.stream] = raw.source_state.data
        }
      } else if (raw.type === 'log') {
        const meta = parseGoogleSheetsMetaLog(raw.log.message)
        if (meta?.type === 'row_assignments') {
          for (const [stream, assignments] of Object.entries(meta.assignments)) {
            rowAssignments[stream] ??= {}
            Object.assign(rowAssignments[stream], assignments)
          }
        }
      }
    }

    return { errors, state, written: queued.length, rowAssignments }
  }
}
