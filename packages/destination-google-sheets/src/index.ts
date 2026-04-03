import type {
  CheckResult,
  ConfiguredCatalog,
  ConnectorSpecification,
  Destination,
  DestinationInput,
  DestinationOutput,
  ErrorMessage,
  LogMessage,
} from '@stripe/sync-protocol'
import type { sheets_v4 } from 'googleapis'
import { google } from 'googleapis'
import { z } from 'zod'
import {
  GOOGLE_SHEETS_META_LOG_PREFIX,
  formatGoogleSheetsMetaLog,
  parseGoogleSheetsMetaLog,
  ROW_KEY_FIELD,
  ROW_NUMBER_FIELD,
  serializeRowKey,
  stripSystemFields,
} from './metadata.js'
import { configSchema } from './spec.js'
import type { Config } from './spec.js'
import {
  appendRows,
  createIntroSheet,
  deleteSpreadsheet,
  ensureSheet,
  ensureSpreadsheet,
  protectSheets,
  readHeaderRow,
  updateRows,
} from './writer.js'

export {
  ensureSpreadsheet,
  ensureSheet,
  appendRows,
  updateRows,
  readHeaderRow,
  readSheet,
  createIntroSheet,
  protectSheets,
  deleteSpreadsheet,
} from './writer.js'
export {
  GOOGLE_SHEETS_META_LOG_PREFIX,
  formatGoogleSheetsMetaLog,
  parseGoogleSheetsMetaLog,
  ROW_KEY_FIELD,
  ROW_NUMBER_FIELD,
  serializeRowKey,
  stripSystemFields,
} from './metadata.js'

// MARK: - Spec

export { configSchema, envVars, type Config } from './spec.js'

// MARK: - Helpers

function makeOAuth2Client(config: Config) {
  const clientId = config.client_id || process.env['GOOGLE_CLIENT_ID']
  const clientSecret = config.client_secret || process.env['GOOGLE_CLIENT_SECRET']
  if (!clientId) throw new Error('client_id required (provide in config or set GOOGLE_CLIENT_ID)')
  if (!clientSecret)
    throw new Error('client_secret required (provide in config or set GOOGLE_CLIENT_SECRET)')
  const auth = new google.auth.OAuth2(clientId, clientSecret)
  auth.setCredentials({
    access_token: config.access_token,
    refresh_token: config.refresh_token,
  })
  return auth
}

function makeSheetsClient(config: Config) {
  return google.sheets({ version: 'v4', auth: makeOAuth2Client(config) })
}

function makeDriveClient(config: Config) {
  return google.drive({ version: 'v3', auth: makeOAuth2Client(config) })
}

/** Stringify a value for a Sheets cell. */
function stringify(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** Check if an error looks transient (rate limit or server error). */
function isTransient(err: unknown): boolean {
  if (!(err instanceof Error) || !('code' in err)) return false
  const code = (err as { code: number }).code
  return code === 429 || code >= 500
}

function extendHeaders(
  existingHeaders: string[],
  data: Record<string, unknown>
): { headers: string[]; changed: boolean } {
  const headers = [...existingHeaders]
  let changed = false
  for (const key of Object.keys(data)) {
    if (!headers.includes(key)) {
      headers.push(key)
      changed = true
    }
  }
  return { headers, changed }
}

// MARK: - Destination

/**
 * Create a Google Sheets destination.
 *
 * Pass a `sheetsClient` to inject a fake for testing; omit it for production
 * (each method creates a real client from config credentials).
 */
export function createDestination(
  sheetsClient?: sheets_v4.Sheets
): Destination<Config> & { readonly spreadsheetId: string | undefined } {
  let spreadsheetId: string | undefined

  const destination = {
    /** The spreadsheet ID after write() has created/resolved it. */
    get spreadsheetId() {
      return spreadsheetId
    },

    spec(): ConnectorSpecification {
      return { config: z.toJSONSchema(configSchema) }
    },

    async setup({ config, catalog }: { config: Config; catalog: ConfiguredCatalog }) {
      if (config.spreadsheet_id) {
        spreadsheetId = config.spreadsheet_id
        return
      }
      const sheets = sheetsClient ?? makeSheetsClient(config)
      spreadsheetId = await ensureSpreadsheet(sheets, config.spreadsheet_title)

      // Create the Overview intro tab first (handles "Sheet1" rename if needed)
      const streamNames = catalog.streams.map((s) => s.stream.name)
      await createIntroSheet(sheets, spreadsheetId, streamNames)

      // Create a data tab for each stream with headers derived from its JSON schema
      const sheetIds: number[] = []
      for (const { stream } of catalog.streams) {
        const properties = stream.json_schema?.['properties'] as Record<string, unknown> | undefined
        const headers = properties ? Object.keys(properties) : []
        const sheetId = await ensureSheet(sheets, spreadsheetId, stream.name, headers)
        sheetIds.push(sheetId)
      }

      // Protect all data tabs with a warning so users know edits may be overwritten
      await protectSheets(sheets, spreadsheetId, sheetIds)

      return { spreadsheet_id: spreadsheetId }
    },

    async teardown({ config }: { config: Config }) {
      const id = config.spreadsheet_id
      if (!id) throw new Error('spreadsheet_id is required for teardown')
      const drive = makeDriveClient(config)
      await deleteSpreadsheet(drive, id)
    },

    async check({ config }: { config: Config }): Promise<CheckResult> {
      const sheets = sheetsClient ?? makeSheetsClient(config)
      if (!config.spreadsheet_id) throw new Error('spreadsheet_id is required for check')
      try {
        await sheets.spreadsheets.get({ spreadsheetId: config.spreadsheet_id })
        return { status: 'succeeded' }
      } catch (err) {
        return {
          status: 'failed',
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },

    async *write(
      { config, catalog }: { config: Config; catalog: ConfiguredCatalog },
      $stdin: AsyncIterable<DestinationInput>
    ): AsyncIterable<DestinationOutput> {
      const sheets = sheetsClient ?? makeSheetsClient(config)
      const batchSize = config.batch_size ?? 50
      const primaryKeys = new Map<string, string[][]>(
        catalog.streams.map((configuredStream) => [
          configuredStream.stream.name,
          configuredStream.stream.primary_key,
        ])
      )

      if (config.spreadsheet_id) {
        spreadsheetId = config.spreadsheet_id
      } else {
        spreadsheetId = await ensureSpreadsheet(sheets, config.spreadsheet_title)
      }

      // Per-stream state: column headers plus buffered appends/updates.
      const streamHeaders = new Map<string, string[]>()
      const appendBuffers = new Map<string, Array<{ row: string[]; rowKey?: string }>>()
      const updateBuffers = new Map<string, Array<{ rowNumber: number; values: string[] }>>()
      const rowAssignments: Record<string, Record<string, number>> = {}

      const ensureHeadersForRecord = async (
        streamName: string,
        cleanData: Record<string, unknown>
      ): Promise<string[]> => {
        let headers = streamHeaders.get(streamName)

        if (!headers) {
          try {
            headers = await readHeaderRow(sheets, spreadsheetId!, streamName)
          } catch (error) {
            const code =
              error instanceof Error && 'code' in error
                ? (error as { code?: number }).code
                : undefined
            if (code !== 400 && code !== 404) throw error
            headers = []
          }

          if (headers.length === 0) {
            headers = Object.keys(cleanData)
            await ensureSheet(sheets, spreadsheetId!, streamName, headers)
          }

          streamHeaders.set(streamName, headers)
          appendBuffers.set(streamName, [])
          updateBuffers.set(streamName, [])
        }

        const next = extendHeaders(headers, cleanData)
        if (next.changed) {
          await ensureSheet(sheets, spreadsheetId!, streamName, next.headers)
          streamHeaders.set(streamName, next.headers)
          headers = next.headers
        }

        return headers
      }

      const flushStream = async (streamName: string) => {
        const updates = updateBuffers.get(streamName)
        if (updates && updates.length > 0) {
          await updateRows(sheets, spreadsheetId!, streamName, updates)
          updateBuffers.set(streamName, [])
        }

        const appends = appendBuffers.get(streamName)
        if (!appends || appends.length === 0) return

        const range = await appendRows(
          sheets,
          spreadsheetId!,
          streamName,
          appends.map((entry) => entry.row)
        )
        if (range) {
          const expectedEndRow = range.startRow + appends.length - 1
          if (range.endRow !== expectedEndRow) {
            throw new Error(
              `Append row mismatch for ${streamName}: expected ${expectedEndRow}, got ${range.endRow}`
            )
          }
          for (let index = 0; index < appends.length; index++) {
            const rowKey = appends[index]?.rowKey
            if (!rowKey) continue
            rowAssignments[streamName] ??= {}
            rowAssignments[streamName][rowKey] = range.startRow + index
          }
        }
        appendBuffers.set(streamName, [])
      }

      const flushAll = async () => {
        for (const streamName of new Set([...appendBuffers.keys(), ...updateBuffers.keys()])) {
          await flushStream(streamName)
        }
      }

      try {
        for await (const msg of $stdin) {
          if (msg.type === 'record') {
            const { stream, data } = msg
            const cleanData = stripSystemFields(data)
            const headers = await ensureHeadersForRecord(stream, cleanData)
            const row = headers.map((header) => stringify(cleanData[header]))
            const rowNumber =
              typeof data[ROW_NUMBER_FIELD] === 'number' ? data[ROW_NUMBER_FIELD] : undefined
            const primaryKey = primaryKeys.get(stream)
            const rowKey =
              typeof data[ROW_KEY_FIELD] === 'string'
                ? data[ROW_KEY_FIELD]
                : primaryKey
                  ? serializeRowKey(primaryKey, cleanData)
                  : undefined

            if (rowNumber !== undefined) {
              updateBuffers.get(stream)!.push({ rowNumber, values: row })
            } else {
              appendBuffers.get(stream)!.push({ row, rowKey })
            }

            const appendCount = appendBuffers.get(stream)?.length ?? 0
            const updateCount = updateBuffers.get(stream)?.length ?? 0
            if (appendCount + updateCount >= batchSize) {
              await flushStream(stream)
            }
          } else if (msg.type === 'state') {
            // Flush the stream's pending rows, then re-emit the state checkpoint
            await flushStream(msg.stream)
            yield msg
          }
        }

        // Flush any remaining rows
        await flushAll()
      } catch (err: unknown) {
        // Attempt to flush what we have before yielding the error
        try {
          await flushAll()
        } catch {
          // ignore flush errors during error handling
        }

        const errorMsg: ErrorMessage = {
          type: 'error',
          failure_type: isTransient(err) ? 'transient_error' : 'system_error',
          message: err instanceof Error ? err.message : String(err),
          stack_trace: err instanceof Error ? err.stack : undefined,
        }
        yield errorMsg
        return
      }

      if (Object.keys(rowAssignments).length > 0) {
        yield {
          type: 'log',
          level: 'debug',
          message: formatGoogleSheetsMetaLog({
            type: 'row_assignments',
            assignments: rowAssignments,
          }),
        }
      }

      const logMsg: LogMessage = {
        type: 'log',
        level: 'info',
        message: `Sheets destination: wrote to spreadsheet ${spreadsheetId}`,
      }
      yield logMsg
    },
  } satisfies Destination<Config> & { spreadsheetId?: string }

  return destination
}

export default createDestination()
