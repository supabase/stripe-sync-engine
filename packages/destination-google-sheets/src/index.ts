import type { Destination, SourceStateMessage } from '@stripe/sync-protocol'
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
  type EnumValidationRule,
  ensureIntroSheet,
  deleteSpreadsheet,
  ensureSheet,
  ensureSheets,
  getSpreadsheetMeta,
  createSpreadsheet,
  findSheetId,
  protectSheets,
  readEnumValidations,
  readHeaderRow,
  setEnumValidations,
  type BatchReadRequest,
  type StreamEnumValidationRules,
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

/** Stale-write check: numeric compare for finite numbers, else lex; empty `existing` always loses. */
function isStrictlyNewer(incoming: string, existing: string | undefined | null): boolean {
  if (existing === '' || existing == null) return true
  const a = Number(incoming)
  const b = Number(existing)
  if (Number.isFinite(a) && Number.isFinite(b)) return a > b
  return incoming > existing
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

function extractDesiredEnumRules(catalog: {
  streams: Array<{ stream: { name: string; json_schema?: Record<string, unknown> } }>
}): StreamEnumValidationRules {
  const out: StreamEnumValidationRules = new Map()
  for (const { stream } of catalog.streams) {
    const properties = stream.json_schema?.properties as
      | Record<string, { enum?: string[] }>
      | undefined
    if (!properties) continue
    const streamRules = new Map<string, EnumValidationRule>()
    for (const [columnName, property] of Object.entries(properties)) {
      if (!Array.isArray(property?.enum) || property.enum.length === 0) continue
      streamRules.set(columnName, { allowedValues: [...property.enum] })
    }
    if (streamRules.size > 0) out.set(stream.name, streamRules)
  }
  return out
}

function extractRequiredFields(catalog: {
  streams: Array<{ stream: { name: string; json_schema?: Record<string, unknown> } }>
}): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const { stream } of catalog.streams) {
    const required = stream.json_schema?.required
    if (!Array.isArray(required) || required.length === 0) continue
    out.set(
      stream.name,
      new Set(required.filter((value): value is string => typeof value === 'string'))
    )
  }
  return out
}

// MARK: - Destination

/** Runs flushAll, yielding heartbeat logs while it runs; returns any flush error via `yield*`. */
async function* uploadToSheet(
  flushAll: () => Promise<void>,
  heartbeatMs: number
): AsyncGenerator<{ type: 'log'; log: { level: 'debug'; message: string } }, unknown, unknown> {
  const flushState = { done: false, error: undefined as unknown }
  const flushP = flushAll().then(
    () => {
      flushState.done = true
    },
    (err) => {
      flushState.error = err
      flushState.done = true
    }
  )
  const flushStartedAt = Date.now()
  while (!flushState.done) {
    await Promise.race([flushP, new Promise((r) => setTimeout(r, heartbeatMs))])
    if (flushState.done) break
    const elapsedSec = Math.round((Date.now() - flushStartedAt) / 1000)
    log.debug(`flushing to Sheets (in progress, ${elapsedSec}s)`)
    yield {
      type: 'log' as const,
      log: {
        level: 'debug' as const,
        message: `flushing to Sheets (in progress, ${elapsedSec}s)`,
      },
    }
  }
  return flushState.error
}

/**
 * Create a Google Sheets destination.
 *
 * Pass a `sheetsClient` to inject a fake for testing; omit it for production
 * (each method creates a real client from config credentials).
 * `options.flushHeartbeatMs` overrides the in-progress heartbeat cadence (default 20s).
 */
export function createDestination(
  sheetsClient?: sheets_v4.Sheets,
  options?: { flushHeartbeatMs?: number }
): Destination<Config> {
  const flushHeartbeatMs = options?.flushHeartbeatMs ?? 20_000
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

      // Ensure every catalog stream has a tab and headers (single batchUpdate + single values.batchUpdate).
      // Data tabs must exist before the Overview is written: its rows contain
      // `=COUNTUNIQUE('<stream>'!A2:A)` formulas that Sheets parses with
      // USER_ENTERED. If the referenced sheet doesn't exist yet the API
      // rejects the update with `Unable to parse range: <stream>!A2:A`.
      const streamHeaders = catalog.streams.map(({ stream }) => {
        const properties = stream.json_schema?.['properties'] as Record<string, unknown> | undefined
        return { streamName: stream.name, headers: properties ? Object.keys(properties) : [] }
      })
      // Refetch meta before each step that reads titles; reusing one snapshot renamed Sheet1 twice.
      const metaBeforeEnsure = await getSpreadsheetMeta(sheets, spreadsheetId)
      const sheetIdMap = await ensureSheets(sheets, spreadsheetId, metaBeforeEnsure, streamHeaders)
      const sheetIds = catalog.streams.map((s) => sheetIdMap.get(s.stream.name)!)

      const streamNames = catalog.streams.map((s) => s.stream.name)
      const metaAfterEnsure = await getSpreadsheetMeta(sheets, spreadsheetId)
      const desiredEnumRules = extractDesiredEnumRules(catalog)

      // Fail loud on changed enum lists — silent overwrites would mask misconfig.
      // Read existing validations before writing so we can detect mismatches.
      const existingSheetNames = new Set(metaAfterEnsure.sheets.map((s) => s.title))
      const existingValidations = await readEnumValidations(
        sheets,
        spreadsheetId,
        streamHeaders.filter(({ streamName }) => existingSheetNames.has(streamName))
      )
      for (const [streamName, desiredStreamRules] of desiredEnumRules) {
        const existingStreamRules = existingValidations.get(streamName)
        if (!existingStreamRules) continue
        for (const [col, desired] of desiredStreamRules) {
          const existing = existingStreamRules.get(col)
          if (!existing) continue
          const desiredSet = new Set(desired.allowedValues)
          const existingSet = new Set(existing.allowedValues)
          if (
            desiredSet.size === existingSet.size &&
            [...desiredSet].every((v) => existingSet.has(v))
          )
            continue
          const fmt = (vals: string[]) => [...vals].sort().join(', ')
          throw new Error(
            `Google Sheets destination: enum values changed for "${col}" on sheet "${streamName}" in spreadsheet ${spreadsheetId}. ` +
              `Existing validation allows [${fmt(existing.allowedValues)}]; new catalog wants [${fmt(desired.allowedValues)}]. ` +
              `Remove the data validation on the ${col} column before re-running setup.`
          )
        }
      }

      await setEnumValidations(sheets, spreadsheetId, sheetIdMap, streamHeaders, desiredEnumRules)
      await ensureIntroSheet(sheets, spreadsheetId, metaAfterEnsure, streamNames)

      await protectSheets(sheets, spreadsheetId, metaAfterEnsure, sheetIds)

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

      const streamNewerThanField = new Map(
        catalog.streams.map((cs) => [cs.stream.name, cs.stream.newer_than_field])
      )

      const spreadsheetId = config.spreadsheet_id
        ? config.spreadsheet_id
        : await createSpreadsheet(sheets, config.spreadsheet_title)

      const streamHeadersFromCatalog = catalog.streams.map(({ stream }) => {
        const properties = stream.json_schema?.properties as Record<string, unknown> | undefined
        return { streamName: stream.name, headers: properties ? Object.keys(properties) : [] }
      })
      const existingSheetNames = new Set(
        (await getSpreadsheetMeta(sheets, spreadsheetId)).sheets.map((sheet) => sheet.title)
      )
      const enumValidations = await readEnumValidations(
        sheets,
        spreadsheetId,
        streamHeadersFromCatalog.filter(({ streamName }) => existingSheetNames.has(streamName))
      )
      const requiredFields = extractRequiredFields(catalog)

      // Per-stream state: column headers plus buffered appends/updates/deletes.
      const streamHeaders = new Map<string, string[]>()
      const sheetIds = new Map<string, number>()
      const appendBuffers = new Map<string, Array<{ row: string[]; rowKey?: string }>>()
      const updateBuffers = new Map<string, Array<{ rowNumber: number; values: string[] }>>()
      const deleteBuffers = new Map<string, Array<{ rowKey?: string; rowNumber?: number }>>()
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
          deleteBuffers.set(streamName, [])
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
        let totalBufferedDeletes = 0
        for (const [, arr] of appendBuffers) totalBufferedAppends += arr.length
        for (const [, arr] of updateBuffers) totalBufferedUpdates += arr.length
        for (const [, arr] of deleteBuffers) totalBufferedDeletes += arr.length
        log.debug(
          {
            appends: totalBufferedAppends,
            updates: totalBufferedUpdates,
            deletes: totalBufferedDeletes,
            streams: appendBuffers.size,
          },
          'flushAll start'
        )

        const opsByStream = new Map<string, StreamBatchOps>()
        const streamNames = [
          ...new Set([...appendBuffers.keys(), ...updateBuffers.keys(), ...deleteBuffers.keys()]),
        ]

        // Streams with keyed appends or any deletes need a read-before-flush
        // pass: appends for dedupe, deletes for rowKey → rowNumber resolution
        // and last-row-swap donor values.
        type StreamPrep = {
          streamName: string
          sheetId: number
          headers: string[]
          primaryKey: string[][] | undefined
          appends: Array<{ row: string[]; rowKey?: string }>
          bufferedUpdates: Array<{ rowNumber: number; values: string[] }>
          bufferedDeletes: Array<{ rowNumber?: number; rowKey?: string }>
          needsRead: boolean
        }
        const prepInputs: StreamPrep[] = []
        for (const streamName of streamNames) {
          const bufferedAppends = (appendBuffers.get(streamName) ?? []).slice()
          const bufferedUpdates = (updateBuffers.get(streamName) ?? []).slice()
          const bufferedDeletes = (deleteBuffers.get(streamName) ?? []).slice()

          if (
            bufferedAppends.length === 0 &&
            bufferedUpdates.length === 0 &&
            bufferedDeletes.length === 0
          ) {
            continue
          }

          const sheetId = sheetIds.get(streamName)
          if (sheetId === undefined) continue

          const headers = streamHeaders.get(streamName) ?? []
          const primaryKey = primaryKeys.get(streamName)
          const needsRead =
            !!primaryKey &&
            primaryKey.length > 0 &&
            headers.length > 0 &&
            (bufferedAppends.some((e) => e.rowKey) || bufferedDeletes.length > 0)

          prepInputs.push({
            streamName,
            sheetId,
            headers,
            primaryKey,
            appends: bufferedAppends,
            bufferedUpdates,
            bufferedDeletes,
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
          const newerThanField = streamNewerThanField.get(prep.streamName)
          const newerThanIdx = newerThanField ? prep.headers.indexOf(newerThanField) : -1
          const pkIsFirstN = pkFields.every((field, i) => prep.headers[i] === field)
          const canReadPrefix = prep.bufferedDeletes.length === 0 && pkIsFirstN
          const columnCount =
            canReadPrefix && newerThanIdx >= 0
              ? Math.max(pkFields.length, newerThanIdx + 1)
              : canReadPrefix
                ? pkFields.length
                : undefined
          narrowByStream.set(prep.streamName, columnCount !== undefined)
          streamsToRead.push({
            name: prep.streamName,
            ...(columnCount ? { columnCount } : {}),
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
          const {
            streamName,
            sheetId,
            headers,
            primaryKey,
            bufferedUpdates,
            bufferedDeletes,
            needsRead,
          } = prep
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

              const newerThanField = streamNewerThanField.get(streamName)
              const newerThanIdx = newerThanField ? headers.indexOf(newerThanField) : -1
              const remaining: typeof appends = []
              let converted = 0
              let staleSkipped = 0
              for (const entry of appends) {
                const existing = entry.rowKey ? freshMap.get(entry.rowKey) : undefined
                if (existing !== undefined) {
                  if (newerThanIdx >= 0) {
                    const existingRow = allRows[isNarrow ? existing - 2 : existing - 1] ?? []
                    const existingCell = existingRow[newerThanIdx]
                    const existingValue = existingCell == null ? '' : String(existingCell)
                    const incomingValue = entry.row[newerThanIdx] ?? ''
                    if (!isStrictlyNewer(incomingValue, existingValue)) {
                      staleSkipped++
                      continue
                    }
                  }
                  bufferedUpdates.push({ rowNumber: existing, values: entry.row })
                  converted++
                } else {
                  remaining.push(entry)
                }
              }
              appends = remaining
              if (converted > 0 || staleSkipped > 0) {
                log.debug(
                  {
                    streamName,
                    existingRows: existingRowCount,
                    keys: freshMap.size,
                    converted,
                    staleSkipped,
                  },
                  'dedup: converted appends to updates'
                )
              }

              // Delete handling. Each delete resolves to a sheet rowNumber;
              // we then fill those rows in two phases:
              //   Phase 1 — donate pending appends: overwrite a deleted row
              //             with an append's values instead of adding that
              //             append at the bottom.
              //   Phase 2 — tail-row swap: for surplus deletes, copy the
              //             sheet's bottom-most surviving rows into the
              //             deleted slots and blank the donor rows.
              if (bufferedDeletes.length > 0) {
                // In-batch reconcile by rowKey: a delete and a pending
                // append for the same key cancel out — the row isn't in
                // the sheet yet (we'd be about to append it) and the delete
                // would immediately overwrite it. Drop both sides.
                for (let i = bufferedDeletes.length - 1; i >= 0; i--) {
                  const key = bufferedDeletes[i].rowKey
                  if (key === undefined) continue
                  const appendIdx = appends.findIndex((a) => a.rowKey === key)
                  if (appendIdx >= 0) {
                    appends.splice(appendIdx, 1)
                    bufferedDeletes.splice(i, 1)
                  }
                }

                const deleteRowNumbers = new Set<number>()
                for (const entry of bufferedDeletes) {
                  let rowNumber: number | undefined
                  if (typeof entry.rowNumber === 'number') rowNumber = entry.rowNumber
                  else if (entry.rowKey) rowNumber = freshMap.get(entry.rowKey)
                  // Row 1 is the header row; data rows are [2, existingRowCount].
                  if (rowNumber !== undefined && rowNumber >= 2 && rowNumber <= existingRowCount) {
                    deleteRowNumbers.add(rowNumber)
                  }
                }

                if (deleteRowNumbers.size > 0) {
                  // Google sheets API omits trailing blank cells, so we add 
                  // an extra empty cell. 
                  const blankRow = new Array<string>(headers.length + 1).fill('')
                  const deleteList = [...deleteRowNumbers].sort((a, b) => a - b)

                  // Phase 1 — donate pending appends into deleted slots. If
                  // the donor had a rowKey, record its new home in
                  // rowAssignments (it no longer lands at the bottom).
                  let donated = 0
                  while (donated < deleteList.length && appends.length > 0) {
                    const targetRow = deleteList[donated]
                    const donor = appends.shift()!
                    bufferedUpdates.push({ rowNumber: targetRow, values: donor.row })
                    if (donor.rowKey) {
                      rowAssignments[streamName] ??= {}
                      rowAssignments[streamName][donor.rowKey] = targetRow
                    }
                    donated++
                  }

                  // Phase 2 — surplus deletes pull from the sheet tail.
                  const remainingDeletes = deleteList.slice(donated)
                  const K = remainingDeletes.length
                  let swapped = 0
                  let blanked = 0
                  if (K > 0 && !isNarrow) {
                    const tailStart = existingRowCount - K + 1
                    const survivorDonors: number[] = []
                    for (let r = tailStart; r <= existingRowCount; r++) {
                      if (!deleteRowNumbers.has(r)) survivorDonors.push(r)
                    }
                    // Body deletes get a tail survivor's values; |survivors|
                    // == |body deletes| by construction (both equal K − k
                    // where k is the count of deletes already in the tail).
                    const bodyDeletes = remainingDeletes.filter((r) => r < tailStart)
                    const tailDeletes = remainingDeletes.filter((r) => r >= tailStart)
                    for (let i = 0; i < bodyDeletes.length; i++) {
                      const deletedRow = bodyDeletes[i]
                      const donorRow = survivorDonors[i]
                      // Full read: row 1 is headers, sheet row R ↔ allRows[R-1].
                      const donorValues = (allRows[donorRow - 1] ?? []).map((v) =>
                        v == null ? '' : String(v)
                      )
                      bufferedUpdates.push({ rowNumber: deletedRow, values: donorValues })
                      bufferedUpdates.push({ rowNumber: donorRow, values: blankRow })
                      swapped++
                    }
                    // Deletes already in the trailing range just get cleared.
                    for (const deletedRow of tailDeletes) {
                      bufferedUpdates.push({ rowNumber: deletedRow, values: blankRow })
                      blanked++
                    }
                  } else if (K > 0 && isNarrow) {
                    // Defensive: narrow reads are suppressed for streams
                    // with deletes, so we shouldn't hit this. Fall back to
                    // blanking without a tail swap so behavior stays sane.
                    log.warn(
                      { streamName, count: K },
                      'deletes present on narrow-read stream; blanking without swap'
                    )
                    for (const rowNumber of remainingDeletes) {
                      bufferedUpdates.push({ rowNumber, values: blankRow })
                      blanked++
                    }
                  }

                  log.debug(
                    {
                      streamName,
                      deletes: deleteRowNumbers.size,
                      donatedFromAppends: donated,
                      swapped,
                      blanked,
                    },
                    'delete handling'
                  )
                }
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
          deleteBuffers.set(streamName, [])
        }

        log.info({ durationMs: Date.now() - flushStart }, 'flushAll done')
      }

      const writeStart = Date.now()
      let recordCount = 0
      let stateCount = 0
      // Buffer source_state until after flushAll so checkpoints only advance once records are durable.
      const bufferedStates: SourceStateMessage[] = []
      let flushSucceeded = false

      // Flush runs only after $stdin completes normally. Early iterator.return()
      // (hard time_limit / abort) drops the batch — state-after-flush must not
      // advance a checkpoint past data we never wrote.
      try {
        for await (const msg of $stdin) {
          if (msg.type === 'record') {
            recordCount++
            const { stream, data, recordDeleted } = msg.record
            const cleanData: Record<string, unknown> = stripSystemFields(data)
            const newerThanField = streamNewerThanField.get(stream)
            if (
              newerThanField !== undefined &&
              (!(newerThanField in cleanData) || cleanData[newerThanField] === undefined)
            ) {
              throw new Error(
                `stream "${stream}" record missing newer_than_field "${newerThanField}"; source must stamp this field on every record per DDR-009`
              )
            }

            const streamEnumRules = enumValidations.get(stream)
            for (const [col, rule] of streamEnumRules ?? []) {
              const value =
                Object.prototype.hasOwnProperty.call(cleanData, col) && cleanData[col] !== undefined
                  ? String(cleanData[col] ?? '')
                  : undefined
              if (value === undefined) {
                if (requiredFields.get(stream)?.has(col)) {
                  throw new Error(
                    `Sheets rejected ${stream}.${col}=undefined (required enum; allowed ${rule.allowedValues.join(',')})`
                  )
                }
                continue
              }
              if (!rule.allowedValues.includes(value)) {
                throw new Error(
                  `Sheets rejected ${stream}.${col}=${JSON.stringify(value)} (not in ${rule.allowedValues.join(',')})`
                )
              }
            }

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

            if (recordDeleted === true) {
              deleteBuffers.get(stream)!.push({ rowKey, rowNumber })
            } else if (rowNumber !== undefined) {
              // 1. Explicit _row_number (backwards compat with service layer)
              updateBuffers.get(stream)!.push({ rowNumber, values: row })
            } else if (rowKey) {
              // Upsert: buffer as append + in-batch dedup. flushAll splits
              // into final appends vs updates after reading the sheet.
              const buffer = appendBuffers.get(stream)!
              const keyIdx = appendKeyIndex.get(stream)!
              const pendingIdx = keyIdx.get(rowKey)
              if (pendingIdx !== undefined) {
                if (newerThanField !== undefined) {
                  const newerThanIdx = headers.indexOf(newerThanField)
                  const incomingValue = row[newerThanIdx]
                  const pendingValue = buffer[pendingIdx].row[newerThanIdx]
                  if (incomingValue === undefined || pendingValue === undefined) {
                    throw new Error(
                      `stream "${stream}" record missing newer_than_field "${newerThanField}" (header index ${newerThanIdx}); source must stamp this field on every record per DDR-009`
                    )
                  }
                  if (!isStrictlyNewer(incomingValue, pendingValue)) {
                    log.debug(
                      {
                        stream,
                        rowKey,
                        newerThanField,
                        incomingValue,
                        pendingValue,
                      },
                      'in-batch dedup: ignoring stale record'
                    )
                    yield msg
                    continue
                  }
                }
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
          } else if (msg.type === 'source_state') {
            stateCount++
            bufferedStates.push(msg)
          } else {
            yield msg
          }
        }
        log.debug(
          { durationMs: Date.now() - writeStart, recordCount, stateCount },
          'Source drained in google sheet write, starting upload step...'
        )
        const flushError = yield* uploadToSheet(flushAll, flushHeartbeatMs)
        if (flushError) {
          log.error({ err: flushError }, 'flushAll failed during teardown')
          const errMsg = flushError instanceof Error ? flushError.message : String(flushError)
          yield {
            type: 'connection_status' as const,
            connection_status: { status: 'failed' as const, message: errMsg },
          }
        } else {
          flushSucceeded = true
          for (const state of bufferedStates) {
            yield state
          }
        }
      } catch (err: unknown) {
        log.error(
          { err, durationMs: Date.now() - writeStart, recordCount, stateCount },
          'write() error'
        )
        yield {
          type: 'connection_status' as const,
          connection_status: {
            status: 'failed' as const,
            message: err instanceof Error ? err.message : String(err),
          },
        }
      }

      if (Object.keys(rowAssignments).length > 0) {
        const metaMsg = formatGoogleSheetsMetaLog({
          type: 'row_assignments',
          assignments: rowAssignments,
        })
        log.debug(metaMsg)
        yield { type: 'log' as const, log: { level: 'debug' as const, message: metaMsg } }
      }

      if (flushSucceeded) {
        yield {
          type: 'log' as const,
          log: {
            level: 'info' as const,
            message: `Sheets destination: wrote to spreadsheet ${spreadsheetId}`,
          },
        }
      }
    },
  } satisfies Destination<Config>

  return destination
}

export default createDestination()
