import { enforceCatalog } from '@stripe/sync-engine'
import type { ConfiguredCatalog, DestinationInput, PipelineConfig } from '@stripe/sync-engine'
import {
  configSchema as googleSheetsConfigSchema,
  createDestination as createGoogleSheetsDestination,
  parseGoogleSheetsMetaLog,
} from '@stripe/sync-destination-google-sheets'
import type { ActivitiesContext } from './_shared.js'
import {
  addRowNumbers,
  asIterable,
  augmentGoogleSheetsCatalog,
  collectError,
  compactGoogleSheetsMessages,
  type RunResult,
} from './_shared.js'

export function createWriteGoogleSheetsFromQueueActivity(context: ActivitiesContext) {
  return async function writeGoogleSheetsFromQueue(
    config: PipelineConfig,
    pipelineId: string,
    opts?: {
      maxBatch?: number
      rowIndex?: Record<string, Record<string, number>>
      catalog?: ConfiguredCatalog
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

    if (queued.length === 0) {
      return { errors: [], state: {}, written: 0, rowAssignments: {} }
    }

    const writeBatch = addRowNumbers(compactGoogleSheetsMessages(queued), opts?.rowIndex ?? {})
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
    const state: Record<string, unknown> = {}
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
      const error = collectError(raw as unknown as Record<string, unknown>)
      if (error) {
        errors.push(error)
      } else if (raw.type === 'state') {
        state[raw.state.stream] = raw.state.data
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
