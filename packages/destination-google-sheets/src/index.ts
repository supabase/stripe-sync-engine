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
  applyBatch,
  batchReadSheets,
  buildRowMapFromPkColumns,
  buildRowMapFromRows,
  ensureIntroSheet,
  deleteSpreadsheet,
  ensureSheet,
  ensureSheets,
  getSpreadsheetMeta,
  createSpreadsheet,
  findSheetId,
  protectSheets,
  readHeaderRow,
  type BatchReadRequest,
  type StreamBatchOps,
} from './writer.js'

export {
  createSpreadsheet,
  ensureSheet,
  ensureSheets,
  getSpreadsheetMeta,
  appendRows,
  updateRows,
  readHeaderRow,
  readSheet,
  buildRowMap,
  ensureIntroSheet,
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
      const sheets = sheetsClient ?? makeSheetsClient(config)
      const isNew = !config.spreadsheet_id
      const spreadsheetId = isNew
        ? await createSpreadsheet(sheets, config.spreadsheet_title)
        : config.spreadsheet_id!

      // Fetch metadata once, reuse for all setup steps
      const meta = await getSpreadsheetMeta(sheets, spreadsheetId)

      // Ensure every catalog stream has a tab and headers (single batchUpdate + single values.batchUpdate).
      // Data tabs must exist before the Overview is written: its rows contain
      // `=COUNTUNIQUE('<stream>'!A2:A)` formulas that Sheets parses with
      // USER_ENTERED. If the referenced sheet doesn't exist yet the API
      // rejects the update with `Unable to parse range: <stream>!A2:A`.
      const streamHeaders = catalog.streams.map(({ stream }) => {
        const properties = stream.json_schema?.['properties'] as Record<string, unknown> | undefined
        return { streamName: stream.name, headers: properties ? Object.keys(properties) : [] }
      })
      const sheetIdMap = await ensureSheets(sheets, spreadsheetId, meta, streamHeaders)
      const sheetIds = catalog.streams.map((s) => sheetIdMap.get(s.stream.name)!)

      // Re-fetch metadata after ensureSheets: it may have renamed Sheet1 to the first
      // stream tab, making the original `meta` stale. ensureIntroSheet uses meta to
      // check whether Sheet1 exists (to rename vs. insert) — if it sees the stale
      // Sheet1 entry it will rename the first stream's tab to "Overview".
      const freshMeta = await getSpreadsheetMeta(sheets, spreadsheetId)

      const streamNames = catalog.streams.map((s) => s.stream.name)
      await ensureIntroSheet(sheets, spreadsheetId, freshMeta, streamNames)

      await protectSheets(sheets, spreadsheetId, freshMeta, sheetIds)

      if (isNew) {
        yield msg.control({
          control_type: 'destination_config',
          destination_config: { ...config, spreadsheet_id: spreadsheetId },
        })
      }
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
      const primaryKeys = new Map<string, string[][]>(
        catalog.streams.map((configuredStream) => [
          configuredStream.stream.name,
          configuredStream.stream.primary_key,
        ])
      )

      const spreadsheetId = config.spreadsheet_id
        ? config.spreadsheet_id
        : await createSpreadsheet(sheets, config.spreadsheet_title)

      // Per-stream state: column headers plus buffered appends/updates.
      const streamHeaders = new Map<string, string[]>()
      const sheetIds = new Map<string, number>()
      const appendBuffers = new Map<string, Array<{ row: string[]; rowKey?: string }>>()
      const updateBuffers = new Map<string, Array<{ rowNumber: number; values: string[] }>>()
      const rowAssignments: Record<string, Record<string, number>> = {}
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
            const sheetId = await ensureSheet(sheets, spreadsheetId, streamName, headers)
            sheetIds.set(streamName, sheetId)
          } else {
            const sheetId = await findSheetId(sheets, spreadsheetId, streamName)
            if (sheetId !== undefined) sheetIds.set(streamName, sheetId)
          }

          streamHeaders.set(streamName, headers)
          appendBuffers.set(streamName, [])
          appendKeyIndex.set(streamName, new Map())
          updateBuffers.set(streamName, [])
        }

        const next = extendHeaders(headers, cleanData)
        if (next.changed) {
          const sheetId = await ensureSheet(sheets, spreadsheetId, streamName, next.headers)
          sheetIds.set(streamName, sheetId)
          streamHeaders.set(streamName, next.headers)
          headers = next.headers
        }

        return headers
      }

      const flushAll = async () => {
        const flushStart = Date.now()
        let totalBufferedAppends = 0
        let totalBufferedUpdates = 0
        for (const [, arr] of appendBuffers) totalBufferedAppends += arr.length
        for (const [, arr] of updateBuffers) totalBufferedUpdates += arr.length
        log.debug(
          {
            appends: totalBufferedAppends,
            updates: totalBufferedUpdates,
            streams: appendBuffers.size,
          },
          'flushAll start'
        )

        const opsByStream = new Map<string, StreamBatchOps>()
        const streamNames = [...new Set([...appendBuffers.keys(), ...updateBuffers.keys()])]

        // Only streams with keyed appends need a read-before-flush pass for dedup.
        type StreamPrep = {
          streamName: string
          sheetId: number
          headers: string[]
          primaryKey: string[][] | undefined
          appends: Array<{ row: string[]; rowKey?: string }>
          bufferedUpdates: Array<{ rowNumber: number; values: string[] }>
          needsRead: boolean
        }
        const prepInputs: StreamPrep[] = []
        for (const streamName of streamNames) {
          const bufferedAppends = appendBuffers.get(streamName) ?? []
          const bufferedUpdates = (updateBuffers.get(streamName) ?? []).slice()
          if (bufferedAppends.length === 0 && bufferedUpdates.length === 0) continue

          const sheetId = sheetIds.get(streamName)
          if (sheetId === undefined) continue

          const headers = streamHeaders.get(streamName) ?? []
          const primaryKey = primaryKeys.get(streamName)
          const needsRead =
            !!primaryKey &&
            primaryKey.length > 0 &&
            headers.length > 0 &&
            bufferedAppends.some((e) => e.rowKey)

          prepInputs.push({
            streamName,
            sheetId,
            headers,
            primaryKey,
            appends: bufferedAppends.slice(),
            bufferedUpdates,
            needsRead,
          })
        }

        // One batchGet fetches all streams' existing rows at the cost of one
        // read-quota unit, avoiding the 300 reads/min limit on wide catalogs.
        // Narrow per-stream range when PK columns are the first N headers
        // (guaranteed by setup); otherwise read the whole tab to locate PK.
        const streamsToRead: BatchReadRequest[] = []
        const narrowByStream = new Map<string, boolean>()
        for (const prep of prepInputs) {
          if (!prep.needsRead || !prep.primaryKey) continue
          const pkFields = prep.primaryKey.map((p) => p[0])
          const pkIsFirstN = pkFields.every((field, i) => prep.headers[i] === field)
          narrowByStream.set(prep.streamName, pkIsFirstN)
          streamsToRead.push({
            name: prep.streamName,
            ...(pkIsFirstN ? { columnCount: pkFields.length } : {}),
          })
        }

        let sheetRows = new Map<string, unknown[][]>()
        if (streamsToRead.length > 0) {
          const readStart = Date.now()
          try {
            sheetRows = await batchReadSheets(sheets, spreadsheetId, streamsToRead)
            let totalRows = 0
            for (const rows of sheetRows.values()) totalRows += rows.length
            log.debug(
              {
                streams: streamsToRead.length,
                narrow: streamsToRead.filter((r) => r.columnCount).length,
                totalRows,
                durationMs: Date.now() - readStart,
              },
              'batchReadSheets'
            )
          } catch (err) {
            log.warn(
              { err, streams: streamsToRead.length, durationMs: Date.now() - readStart },
              'batchReadSheets failed; proceeding without dedup'
            )
          }
        }

        // Per-stream prep from pre-fetched rows. Stream order is preserved
        // so row_assignments tracking matches the previous sequential impl.
        for (const prep of prepInputs) {
          const { streamName, sheetId, headers, primaryKey, bufferedUpdates, needsRead } = prep
          let appends = prep.appends
          let existingRowCount = 0

          if (needsRead && primaryKey) {
            const allRows = sheetRows.get(streamName)
            if (allRows) {
              const isNarrow = narrowByStream.get(streamName) === true
              // Narrow reads skip the header row; add 1 so append startRow is correct.
              existingRowCount = isNarrow ? allRows.length + 1 : allRows.length
              const freshMap = isNarrow
                ? buildRowMapFromPkColumns(allRows, primaryKey)
                : buildRowMapFromRows(allRows, headers, primaryKey)
              const remaining: typeof appends = []
              let converted = 0
              for (const entry of appends) {
                const existing = entry.rowKey ? freshMap.get(entry.rowKey) : undefined
                if (existing !== undefined) {
                  bufferedUpdates.push({ rowNumber: existing, values: entry.row })
                  converted++
                } else {
                  remaining.push(entry)
                }
              }
              appends = remaining
              if (converted > 0) {
                log.debug(
                  {
                    streamName,
                    existingRows: existingRowCount,
                    keys: freshMap.size,
                    converted,
                  },
                  'dedup: converted appends to updates'
                )
              }
            }
          }

          opsByStream.set(streamName, {
            sheetId,
            updates: bufferedUpdates,
            appends: appends.map((entry) => entry.row),
            existingRowCount,
          })
          // Stash deduped entries so row_assignments can be emitted after
          // applyBatch returns per-stream start rows.
          appendBuffers.set(streamName, appends)
        }

        if (opsByStream.size === 0) {
          log.debug({ durationMs: Date.now() - flushStart }, 'flushAll: nothing to flush')
          return
        }

        let totalAppends = 0
        let totalUpdates = 0
        for (const ops of opsByStream.values()) {
          totalAppends += ops.appends.length
          totalUpdates += ops.updates.length
        }
        log.debug(
          { appends: totalAppends, updates: totalUpdates, streams: opsByStream.size },
          'applyBatch start'
        )
        const applyStart = Date.now()
        const results = await applyBatch(sheets, spreadsheetId, opsByStream)
        log.debug({ durationMs: Date.now() - applyStart }, 'applyBatch done')

        for (const [streamName, { appendStartRow }] of results) {
          const appends = appendBuffers.get(streamName) ?? []
          for (let index = 0; index < appends.length; index++) {
            const rowKey = appends[index]?.rowKey
            if (!rowKey) continue
            const rowNumber = appendStartRow + index
            rowAssignments[streamName] ??= {}
            rowAssignments[streamName][rowKey] = rowNumber
          }
        }

        for (const streamName of opsByStream.keys()) {
          appendBuffers.set(streamName, [])
          appendKeyIndex.get(streamName)?.clear()
          updateBuffers.set(streamName, [])
        }

        log.debug({ durationMs: Date.now() - flushStart }, 'flushAll done')
      }

      const writeStart = Date.now()
      let recordCount = 0
      let stateCount = 0
      let writeError: unknown = undefined
      let cancelled = true

      // try/finally ensures flushAll runs even when the consumer closes us
      // early via iterator.return() (e.g. takeLimits eof). Otherwise the
      // buffered batch would be silently dropped.
      try {
        for await (const msg of $stdin) {
          if (msg.type === 'record') {
            recordCount++
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
              // Upsert: buffer as append + in-batch dedup. flushAll splits
              // into final appends vs updates after reading the sheet.
              const buffer = appendBuffers.get(stream)!
              const keyIdx = appendKeyIndex.get(stream)!
              const pendingIdx = keyIdx.get(rowKey)
              if (pendingIdx !== undefined) {
                buffer[pendingIdx] = { row, rowKey }
              } else {
                keyIdx.set(rowKey, buffer.length)
                buffer.push({ row, rowKey })
              }
            } else {
              // 3. No key at all — pure append
              appendBuffers.get(stream)!.push({ row })
            }
            yield msg
          } else {
            if (msg.type === 'source_state') stateCount++
            // Pass through non-record messages immediately; data is flushed at end.
            yield msg
          }
        }

        cancelled = false
        log.debug(
          { durationMs: Date.now() - writeStart, recordCount, stateCount },
          '$stdin drained'
        )
      } catch (err: unknown) {
        cancelled = false
        writeError = err
        log.error(
          { err, durationMs: Date.now() - writeStart, recordCount, stateCount },
          'write() error'
        )
      } finally {
        if (cancelled) {
          log.warn(
            { durationMs: Date.now() - writeStart, recordCount, stateCount },
            'write() cancelled by consumer; flushing buffered data anyway'
          )
        }
        try {
          await flushAll()
        } catch (flushErr) {
          log.error({ err: flushErr }, 'flushAll failed during teardown')
          if (!writeError) writeError = flushErr
        }
      }

      if (writeError) {
        const errMsg = writeError instanceof Error ? writeError.message : String(writeError)
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
