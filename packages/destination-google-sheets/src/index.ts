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
  buildRowMap,
  createIntroSheet,
  deleteSpreadsheet,
  ensureSheet,
  ensureSpreadsheet,
  findSheetId,
  protectSheets,
  readHeaderRow,
  readSheet,
  type StreamBatchOps,
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
      const primaryKeys = new Map<string, string[][]>(
        catalog.streams.map((configuredStream) => [
          configuredStream.stream.name,
          configuredStream.stream.primary_key,
        ])
      )

      const spreadsheetId = config.spreadsheet_id
        ? config.spreadsheet_id
        : await ensureSpreadsheet(sheets, config.spreadsheet_title)

      // Per-stream state: column headers, sheetIds, plus buffered appends/updates.
      // All writes are accumulated and flushed in a single `spreadsheets.batchUpdate`
      // call at the end of this generator (see `flushAll` below).
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
        console.error(
          `[google-sheets] flushAll start: ${totalBufferedAppends} appends + ${totalBufferedUpdates} updates across ${appendBuffers.size} streams`
        )

        const opsByStream = new Map<string, StreamBatchOps>()

        for (const streamName of new Set([...appendBuffers.keys(), ...updateBuffers.keys()])) {
          const bufferedAppends = appendBuffers.get(streamName) ?? []
          const bufferedUpdates = (updateBuffers.get(streamName) ?? []).slice()
          if (bufferedAppends.length === 0 && bufferedUpdates.length === 0) continue

          const sheetId = sheetIds.get(streamName)
          if (sheetId === undefined) continue

          const headers = streamHeaders.get(streamName) ?? []
          const primaryKey = primaryKeys.get(streamName)
          let appends = bufferedAppends.slice()
          let existingRowCount = 0

          // Refresh from the sheet to (a) dedup against rows written by prior
          // write() calls or Temporal retries and (b) compute the starting row
          // number for new appends (needed because `appendCells` replies don't
          // carry ranges).
          if (
            primaryKey &&
            primaryKey.length > 0 &&
            headers.length > 0 &&
            appends.some((e) => e.rowKey)
          ) {
            const readStart = Date.now()
            let converted = 0
            try {
              const allRows = await readSheet(sheets, spreadsheetId, streamName)
              existingRowCount = allRows.length
              const freshMap = await buildRowMap(
                sheets,
                spreadsheetId,
                streamName,
                headers,
                primaryKey
              )

              const remaining: typeof appends = []
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
              console.error(
                `[google-sheets] readSheet+buildRowMap(${streamName}): ${existingRowCount} rows, ${freshMap.size} keys, converted ${converted} appends→updates in ${Date.now() - readStart}ms`
              )
            } catch (err) {
              console.error(
                `[google-sheets] readSheet+buildRowMap(${streamName}) failed in ${Date.now() - readStart}ms: ${err instanceof Error ? err.message : String(err)}`
              )
              // Sheet read failed — proceed with append (best effort)
            }
          }

          // Sort appends by rowKey so rows land in a deterministic order on
          // the sheet regardless of the order the source emitted them (and
          // regardless of interleaving from concurrent stream generators in
          // the source). Keyless appends are grouped to the front in their
          // insertion order — JavaScript's Array.prototype.sort is stable
          // since ES2019. This is sorted here (before building opsByStream
          // AND before stashing into appendBuffers) so that the row_assignments
          // computation still maps each append's rowKey to its final rowNumber.
          appends.sort((a, b) => {
            const ak = a.rowKey ?? ''
            const bk = b.rowKey ?? ''
            if (ak === bk) return 0
            return ak < bk ? -1 : 1
          })

          opsByStream.set(streamName, {
            sheetId,
            updates: bufferedUpdates,
            appends: appends.map((entry) => entry.row),
            existingRowCount,
          })

          // Stash the (deduped, sorted) append entries so we can emit
          // row_assignments after applyBatch returns the start row per stream.
          appendBuffers.set(streamName, appends)
        }

        if (opsByStream.size === 0) {
          console.error(`[google-sheets] flushAll: nothing to flush (took ${Date.now() - flushStart}ms)`)
          return
        }

        let totalAppends = 0
        let totalUpdates = 0
        for (const ops of opsByStream.values()) {
          totalAppends += ops.appends.length
          totalUpdates += ops.updates.length
        }
        console.error(
          `[google-sheets] applyBatch start: ${totalAppends} appends + ${totalUpdates} updates across ${opsByStream.size} streams`
        )
        const applyStart = Date.now()
        const results = await applyBatch(sheets, spreadsheetId, opsByStream)
        console.error(`[google-sheets] applyBatch done in ${Date.now() - applyStart}ms`)

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

        console.error(`[google-sheets] flushAll done in ${Date.now() - flushStart}ms`)
      }

      const writeStart = Date.now()
      let recordCount = 0
      let stateCount = 0
      let writeError: unknown = undefined
      let cancelled = true

      // The outer try/finally guarantees flushAll runs even when the generator is
      // closed via iterator.return() (e.g. takeLimits emitting eof on
      // state_limit/time_limit). Without this, the buffered batch would be
      // silently dropped whenever an upstream consumer short-circuits the stream.
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
              // 2. Native upsert: buffer as append + dedup by rowKey within this batch.
              //    Final append-vs-update split happens in flushAll once the sheet has been read.
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
            // Pass through all non-record messages (including source_state — state
            // checkpoints are re-emitted immediately; data is flushed once at end).
            yield msg
          }
        }

        cancelled = false
        console.error(
          `[google-sheets] $stdin drained after ${Date.now() - writeStart}ms: ${recordCount} records, ${stateCount} source_state msgs`
        )
      } catch (err: unknown) {
        cancelled = false
        writeError = err
        console.error(
          `[google-sheets] write() error after ${Date.now() - writeStart}ms (records=${recordCount}, states=${stateCount}): ${err instanceof Error ? err.message : String(err)}`
        )
      } finally {
        if (cancelled) {
          console.error(
            `[google-sheets] write() cancelled by consumer after ${Date.now() - writeStart}ms (records=${recordCount}, states=${stateCount}) — flushing buffered data anyway`
          )
        }
        try {
          await flushAll()
        } catch (flushErr) {
          console.error(
            `[google-sheets] flushAll failed during teardown: ${flushErr instanceof Error ? flushErr.message : String(flushErr)}`
          )
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
