import type { Destination } from '@stripe/sync-protocol'
import { createSourceMessageFactory } from '@stripe/sync-protocol'

const msg = createSourceMessageFactory()
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
import { log } from './logger.js'
import defaultSpec, { configSchema } from './spec.js'
import type { Config } from './spec.js'
import {
  appendRows,
  buildRowMap,
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
  buildRowMap,
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
export function createDestination(sheetsClient?: sheets_v4.Sheets): Destination<Config> {
  const destination = {
    async *spec() {
      yield { type: 'spec' as const, spec: defaultSpec }
    },

    async *setup({ config, catalog }) {
      if (config.spreadsheet_id) return
      const sheets = sheetsClient ?? makeSheetsClient(config)
      const spreadsheetId = await ensureSpreadsheet(sheets, config.spreadsheet_title)

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

      yield msg.control({ control_type: 'destination_config', destination_config: { ...config, spreadsheet_id: spreadsheetId } })
    },

    async *teardown({ config }) {
      const id = config.spreadsheet_id
      if (!id) throw new Error('spreadsheet_id is required for teardown')
      const drive = makeDriveClient(config)
      await deleteSpreadsheet(drive, id)
    },

    async *check({ config }) {
      const sheets = sheetsClient ?? makeSheetsClient(config)
      if (!config.spreadsheet_id) throw new Error('spreadsheet_id is required for check')
      try {
        await sheets.spreadsheets.get({ spreadsheetId: config.spreadsheet_id })
        yield {
          type: 'connection_status' as const,
          connection_status: { status: 'succeeded' as const },
        }
      } catch (err) {
        yield {
          type: 'connection_status' as const,
          connection_status: {
            status: 'failed' as const,
            message: err instanceof Error ? err.message : String(err),
          },
        }
      }
    },

    async *write({ config, catalog }, $stdin) {
      const sheets = sheetsClient ?? makeSheetsClient(config)
      const batchSize = config.batch_size ?? 50
      const primaryKeys = new Map<string, string[][]>(
        catalog.streams.map((configuredStream) => [
          configuredStream.stream.name,
          configuredStream.stream.primary_key,
        ])
      )

      const spreadsheetId = config.spreadsheet_id
        ? config.spreadsheet_id
        : await ensureSpreadsheet(sheets, config.spreadsheet_title)

      // Per-stream state: column headers plus buffered appends/updates.
      const streamHeaders = new Map<string, string[]>()
      const appendBuffers = new Map<string, Array<{ row: string[]; rowKey?: string }>>()
      const updateBuffers = new Map<string, Array<{ rowNumber: number; values: string[] }>>()
      const rowAssignments: Record<string, Record<string, number>> = {}
      // Row maps for native upsert: rowKey → 1-based row number per stream
      const rowMaps = new Map<string, Map<string, number>>()
      // Tracks whether we've refreshed the row map from the sheet for each stream
      // (once per write() call, on first flush)
      const rowMapRefreshed = new Set<string>()
      // Pending append index: rowKey → index in appendBuffers for O(1) in-batch dedup
      const appendKeyIndex = new Map<string, Map<string, number>>()

      const ensureHeadersForRecord = async (
        streamName: string,
        cleanData: Record<string, unknown>
      ): Promise<string[]> => {
        let headers = streamHeaders.get(streamName)

        if (!headers) {
          try {
            headers = await readHeaderRow(sheets, spreadsheetId, streamName)
          } catch (error) {
            const code =
              error instanceof Error && 'code' in error
                ? (error as { code?: number }).code
                : undefined
            if (code !== 400 && code !== 404) throw error
            headers = []
          }

          if (headers.length === 0) {
            // Place primary key columns first so buildRowMap can read minimal columns
            const pk = primaryKeys.get(streamName)
            const pkFields = pk?.map((path) => path[0]) ?? []
            const rest = Object.keys(cleanData).filter((k) => !pkFields.includes(k))
            headers = [...pkFields.filter((k) => k in cleanData), ...rest]
            await ensureSheet(sheets, spreadsheetId, streamName, headers)
          }

          streamHeaders.set(streamName, headers)
          appendBuffers.set(streamName, [])
          appendKeyIndex.set(streamName, new Map())
          updateBuffers.set(streamName, [])
        }

        const next = extendHeaders(headers, cleanData)
        if (next.changed) {
          await ensureSheet(sheets, spreadsheetId, streamName, next.headers)
          streamHeaders.set(streamName, next.headers)
          headers = next.headers
        }

        return headers
      }

      const ensureRowMapForStream = async (streamName: string): Promise<Map<string, number>> => {
        let map = rowMaps.get(streamName)
        if (!map) {
          const primaryKey = primaryKeys.get(streamName)
          const headers = streamHeaders.get(streamName)
          if (primaryKey && primaryKey.length > 0 && headers) {
            try {
              map = await buildRowMap(sheets, spreadsheetId, streamName, headers, primaryKey)
              rowMapRefreshed.add(streamName)
            } catch {
              map = new Map() // sheet doesn't exist yet or is empty
            }
          } else {
            map = new Map() // no primary key or no headers = append-only
          }
          rowMaps.set(streamName, map)
        }
        return map
      }

      const flushStream = async (streamName: string) => {
        const updates = updateBuffers.get(streamName)
        if (updates && updates.length > 0) {
          await updateRows(sheets, spreadsheetId, streamName, updates)
          updateBuffers.set(streamName, [])
        }

        let appends = appendBuffers.get(streamName)
        if (!appends || appends.length === 0) return

        // On the first flush per stream, refresh the row map from the sheet
        // to catch rows written by previous write() calls or Temporal activity
        // retries. Only done once per write() to avoid excessive API calls.
        const primaryKey = primaryKeys.get(streamName)
        const headers = streamHeaders.get(streamName)
        if (
          !rowMapRefreshed.has(streamName) &&
          primaryKey &&
          primaryKey.length > 0 &&
          headers &&
          appends.some((e) => e.rowKey)
        ) {
          rowMapRefreshed.add(streamName)
          try {
            const freshMap = await buildRowMap(
              sheets,
              spreadsheetId,
              streamName,
              headers,
              primaryKey
            )
            rowMaps.set(streamName, freshMap)

            const lateUpdates: Array<{ rowNumber: number; values: string[] }> = []
            const remaining: typeof appends = []
            for (const entry of appends) {
              const existing = entry.rowKey ? freshMap.get(entry.rowKey) : undefined
              if (existing !== undefined) {
                lateUpdates.push({ rowNumber: existing, values: entry.row })
              } else {
                remaining.push(entry)
              }
            }

            if (lateUpdates.length > 0) {
              await updateRows(sheets, spreadsheetId, streamName, lateUpdates)
            }
            appends = remaining
          } catch {
            // Sheet read failed — proceed with append (best effort)
          }
        }

        if (appends.length === 0) {
          appendBuffers.set(streamName, [])
          appendKeyIndex.get(streamName)?.clear()
          return
        }

        const range = await appendRows(
          sheets,
          spreadsheetId,
          streamName,
          appends.map((entry) => entry.row)
        )
        if (range) {
          const map = rowMaps.get(streamName)
          for (let index = 0; index < appends.length; index++) {
            const rowKey = appends[index]?.rowKey
            if (!rowKey) continue
            const rowNumber = range.startRow + index
            rowAssignments[streamName] ??= {}
            rowAssignments[streamName][rowKey] = rowNumber
            map?.set(rowKey, rowNumber)
          }
        }
        appendBuffers.set(streamName, [])
        appendKeyIndex.get(streamName)?.clear()
      }

      const flushAll = async () => {
        for (const streamName of new Set([...appendBuffers.keys(), ...updateBuffers.keys()])) {
          await flushStream(streamName)
        }
      }

      try {
        for await (const msg of $stdin) {
          if (msg.type === 'record') {
            const { stream, data } = msg.record
            const cleanData = stripSystemFields(data)
            const headers = await ensureHeadersForRecord(stream, cleanData)
            const row = headers.map((header) => stringify(cleanData[header]))
            const rowNumber =
              typeof data[ROW_NUMBER_FIELD] === 'number' ? data[ROW_NUMBER_FIELD] : undefined
            const primaryKey = primaryKeys.get(stream)
            const rowKey =
              typeof data[ROW_KEY_FIELD] === 'string'
                ? data[ROW_KEY_FIELD]
                : primaryKey && primaryKey.length > 0
                  ? serializeRowKey(primaryKey, cleanData)
                  : undefined

            if (rowNumber !== undefined) {
              // 1. Explicit _row_number (backwards compat with service layer)
              updateBuffers.get(stream)!.push({ rowNumber, values: row })
            } else if (rowKey) {
              // 2. Native upsert: look up row key in the map
              const map = await ensureRowMapForStream(stream)
              const existingRow = map.get(rowKey)
              if (existingRow !== undefined) {
                updateBuffers.get(stream)!.push({ rowNumber: existingRow, values: row })
              } else {
                const buffer = appendBuffers.get(stream)!
                const keyIdx = appendKeyIndex.get(stream)!
                const pendingIdx = keyIdx.get(rowKey)
                if (pendingIdx !== undefined) {
                  buffer[pendingIdx] = { row, rowKey }
                } else {
                  keyIdx.set(rowKey, buffer.length)
                  buffer.push({ row, rowKey })
                }
              }
            } else {
              // 3. No key at all — pure append
              appendBuffers.get(stream)!.push({ row })
            }

            const appendCount = appendBuffers.get(stream)?.length ?? 0
            const updateCount = updateBuffers.get(stream)?.length ?? 0
            if (appendCount + updateCount >= batchSize) {
              await flushStream(stream)
            }
            yield msg
          } else if (msg.type === 'source_state') {
            // Flush the stream's pending rows, then re-emit the state checkpoint
            if (msg.source_state.state_type === 'global') {
              await flushAll()
            } else {
              await flushStream(msg.source_state.stream)
            }
            yield msg
          } else {
            // Pass through messages the destination doesn't handle
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

        const errMsg = err instanceof Error ? err.message : String(err)
        log.error(errMsg)
        yield {
          type: 'connection_status' as const,
          connection_status: { status: 'failed' as const, message: errMsg },
        }
        return
      }

      if (Object.keys(rowAssignments).length > 0) {
        const metaMsg = formatGoogleSheetsMetaLog({
          type: 'row_assignments',
          assignments: rowAssignments,
        })
        log.debug(metaMsg)
        yield { type: 'log' as const, log: { level: 'debug' as const, message: metaMsg } }
      }

      log.info(`Sheets destination: wrote to spreadsheet ${spreadsheetId}`)
      yield {
        type: 'log' as const,
        log: {
          level: 'info' as const,
          message: `Sheets destination: wrote to spreadsheet ${spreadsheetId}`,
        },
      }
    },
  } satisfies Destination<Config>

  return destination
}

export default createDestination()
