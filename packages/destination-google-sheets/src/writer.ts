import type { drive_v3, sheets_v4 } from 'googleapis'
import { log } from './logger.js'
import { serializeRowKey } from './metadata.js'

/** Low-level Sheets API ops. Caller supplies an authenticated client. */

const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 32000
const MAX_RETRIES = 5

async function withRetry<T>(fn: () => Promise<T>, label?: string): Promise<T> {
  let delay = BACKOFF_BASE_MS
  const overallStart = Date.now()
  if (label) {
    log.debug({ label }, 'withRetry start')
  }
  for (let attempt = 0; ; attempt++) {
    const attemptStart = Date.now()
    try {
      const result = await fn()
      if (label) {
        const attemptMs = Date.now() - attemptStart
        const totalMs = Date.now() - overallStart
        if (attempt === 0) {
          log.debug({ label, attemptMs }, 'withRetry OK first-try')
        } else {
          log.debug(
            { label, attempts: attempt + 1, attemptMs, totalMs },
            'withRetry OK after retries'
          )
        }
      }
      return result
    } catch (err: unknown) {
      const attemptMs = Date.now() - attemptStart
      const rawCode =
        err instanceof Error && 'code' in err ? (err as { code?: number | string }).code : undefined
      const status = typeof rawCode === 'number' ? rawCode : undefined
      const isRateLimit = status === 429
      const isServerError = status !== undefined && status >= 500
      const retriable = isRateLimit || isServerError

      if (retriable && attempt < MAX_RETRIES) {
        if (label) {
          log.warn(
            {
              err,
              label,
              attempt: attempt + 1,
              maxRetries: MAX_RETRIES,
              status,
              attemptMs,
              backingOffMs: delay,
            },
            'withRetry retry'
          )
        }
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, BACKOFF_MAX_MS)
        continue
      }

      if (label) {
        const totalMs = Date.now() - overallStart
        const reason = retriable
          ? `exhausted ${MAX_RETRIES} retries`
          : `non-retriable (status=${rawCode ?? 'none'})`
        log.error(
          { err, label, reason, attempts: attempt + 1, attemptMs, totalMs },
          'withRetry FAIL'
        )
      }
      throw err
    }
  }
}

/** Create a new spreadsheet and return its ID. */
export async function ensureSpreadsheet(sheets: sheets_v4.Sheets, title: string): Promise<string> {
  const res = await withRetry(() =>
    sheets.spreadsheets.create({
      requestBody: { properties: { title } },
      fields: 'spreadsheetId',
    })
  )
  const id = res.data.spreadsheetId
  if (!id) throw new Error('Failed to create spreadsheet — no ID returned')
  return id
}

/**
 * Ensure a tab exists for `streamName` and write its header row. Renames
 * the default "Sheet1" on first use. Returns the numeric sheetId.
 */
export async function ensureSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  streamName: string,
  headers: string[]
): Promise<number> {
  const meta = await withRetry(() =>
    sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties',
    })
  )
  const existing = meta.data.sheets ?? []

  const found = existing.find((s) => s.properties?.title === streamName)
  if (found) {
    await writeHeaderRow(sheets, spreadsheetId, streamName, headers)
    return found.properties!.sheetId!
  }

  // First stream on a fresh spreadsheet: reuse the default Sheet1.
  if (
    existing.length === 1 &&
    existing[0]?.properties?.title === 'Sheet1' &&
    existing[0]?.properties?.sheetId !== undefined
  ) {
    const sheetId = existing[0].properties.sheetId!
    await withRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId, title: streamName },
                fields: 'title',
              },
            },
          ],
        },
      })
    )
    await writeHeaderRow(sheets, spreadsheetId, streamName, headers)
    return sheetId
  }

  const addRes = await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: streamName } } }],
      },
    })
  )
  const sheetId = addRes.data.replies?.[0]?.addSheet?.properties?.sheetId
  if (sheetId == null) {
    throw new Error(`Failed to get sheetId for new sheet "${streamName}"`)
  }
  await writeHeaderRow(sheets, spreadsheetId, streamName, headers)
  return sheetId
}

async function writeHeaderRow(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  headers: string[]
): Promise<void> {
  if (headers.length === 0) return
  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    })
  )
}

/** Read the first row from a sheet tab and treat it as headers. */
export async function readHeaderRow(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string
): Promise<string[]> {
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'!1:1`,
    })
  )
  const [headerRow] = res.data.values ?? []
  return Array.isArray(headerRow) ? headerRow.map((value) => String(value)) : []
}

/** Look up the numeric sheetId for a tab by name. Returns undefined if not found. */
export async function findSheetId(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string
): Promise<number | undefined> {
  const meta = await withRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' })
  )
  const tab = meta.data.sheets?.find((s) => s.properties?.title === sheetName)
  return tab?.properties?.sheetId ?? undefined
}

function parseUpdatedRows(updatedRange: string): { startRow: number; endRow: number } {
  const match = updatedRange.match(/![A-Z]+(\d+)(?::[A-Z]+(\d+))?$/i)
  if (!match) throw new Error(`Unable to parse updated range: ${updatedRange}`)
  return {
    startRow: Number(match[1]),
    endRow: Number(match[2] ?? match[1]),
  }
}

/** Create/update an "Overview" intro tab at index 0. */
export async function createIntroSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  streamNames: string[]
): Promise<void> {
  const TITLE = 'Overview'

  const meta = await withRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' })
  )
  const existing = meta.data.sheets ?? []
  const hasOverview = existing.some((s) => s.properties?.title === TITLE)

  if (!hasOverview) {
    // Reuse Sheet1 if it's the only tab, otherwise insert at index 0.
    const onlySheet1 =
      existing.length === 1 &&
      existing[0]?.properties?.title === 'Sheet1' &&
      existing[0]?.properties?.sheetId !== undefined
    if (onlySheet1) {
      await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                updateSheetProperties: {
                  properties: { sheetId: existing[0]!.properties!.sheetId!, title: TITLE },
                  fields: 'title',
                },
              },
            ],
          },
        })
      )
    } else {
      await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ addSheet: { properties: { title: TITLE, index: 0 } } }],
          },
        })
      )
    }
  }

  const now = new Date().toISOString()
  const rows: string[][] = [
    ['Stripe Sync Engine'],
    [''],
    ['This spreadsheet is managed by Stripe Sync Engine.'],
    ['Data is synced automatically from your Stripe account.'],
    [''],
    ['Synced streams:', '', 'Unique rows', 'Duplicate rows'],
    ...streamNames.map((name) => [
      `  • ${name}`,
      '',
      `=COUNTUNIQUE('${name}'!A2:A)`,
      `=COUNTA('${name}'!A2:A)-COUNTUNIQUE('${name}'!A2:A)`,
    ]),
    [''],
    [`Last setup: ${now}`],
    [''],
    ['⚠️  Do not edit data in the synced tabs. Changes will be overwritten on the next sync.'],
  ]

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${TITLE}'!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    })
  )
}

/**
 * Add warning-only protection to a set of sheets. Users are shown a warning
 * dialog but not blocked. Idempotent — skips already-protected sheets.
 */
export async function protectSheets(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetIds: number[]
): Promise<void> {
  for (const sheetId of sheetIds) {
    try {
      await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                addProtectedRange: {
                  protectedRange: {
                    range: { sheetId },
                    description:
                      'Managed by Stripe Sync Engine — edits may be overwritten on next sync',
                    warningOnly: true,
                  },
                },
              },
            ],
          },
        })
      )
    } catch (err) {
      if (err instanceof Error && err.message.includes('already has sheet protection')) continue
      throw err
    }
  }
}

/** Append rows to a named sheet tab. */
export async function appendRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  rows: unknown[][]
): Promise<{ startRow: number; endRow: number } | undefined> {
  if (rows.length === 0) return

  const res = await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${sheetName}'!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    })
  )
  const updatedRange = res.data.updates?.updatedRange
  return updatedRange ? parseUpdatedRows(updatedRange) : undefined
}

/** Update rows by 1-based row number. One batchUpdate for all. */
export async function updateRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  updates: { rowNumber: number; values: string[] }[]
): Promise<void> {
  if (updates.length === 0) return

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates.map((update) => ({
          range: `'${sheetName}'!A${update.rowNumber}`,
          values: [update.values],
        })),
      },
    })
  )
}

/** Delete a spreadsheet. Uses Drive — Sheets API has no delete. */
export async function deleteSpreadsheet(
  drive: drive_v3.Drive,
  spreadsheetId: string
): Promise<void> {
  await withRetry(() => drive.files.delete({ fileId: spreadsheetId }))
}

/**
 * Pure: serialized primary key → 1-based sheet row number, from rows you've
 * already fetched. `headers` must be known. Prefer this over `buildRowMap`
 * when you also need the row data; avoids a second read.
 */
export function buildRowMapFromRows(
  allRows: unknown[][],
  headers: string[],
  primaryKey: string[][]
): Map<string, number> {
  const pkFields = primaryKey.map((path) => path[0])
  const pkIndices = pkFields.map((field) => headers.indexOf(field))
  if (pkIndices.some((i) => i === -1)) return new Map()

  const map = new Map<string, number>()
  // allRows[0] is the header row; data starts at index 1.
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i] as string[]
    const data: Record<string, unknown> = {}
    for (let j = 0; j < pkFields.length; j++) {
      data[pkFields[j]] = row[pkIndices[j]] ?? ''
    }
    const rowKey = serializeRowKey(primaryKey, data)
    if (rowKey === '[""]' || rowKey === '[null]') continue
    map.set(rowKey, i + 1)
  }
  return map
}

/** readSheet + buildRowMapFromRows. Use the latter directly if you have the rows. */
export async function buildRowMap(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  headers: string[],
  primaryKey: string[][]
): Promise<Map<string, number>> {
  const allRows = await readSheet(sheets, spreadsheetId, sheetName)
  return buildRowMapFromRows(allRows, headers, primaryKey)
}

/** Read all values from a sheet tab. */
export async function readSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string
): Promise<unknown[][]> {
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${sheetName}'`,
    })
  )
  return (res.data.values ?? []) as unknown[][]
}

/**
 * Read multiple sheet tabs in one `values.batchGet` call. Replaces N
 * parallel reads with 1 request and 1 read-quota unit — required for wide
 * catalogs (otherwise blows the 300/min read limit). Missing tabs map to
 * empty arrays so callers can always `.get()` safely.
 */
export async function batchReadSheets(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetNames: string[]
): Promise<Map<string, unknown[][]>> {
  const result = new Map<string, unknown[][]>()
  if (sheetNames.length === 0) return result
  const res = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: sheetNames.map((name) => `'${name}'`),
    })
  )
  const valueRanges = res.data.valueRanges ?? []
  for (let i = 0; i < sheetNames.length; i++) {
    const entry = valueRanges[i]
    const values = (entry?.values ?? []) as unknown[][]
    result.set(sheetNames[i], values)
  }
  return result
}

export interface StreamBatchOps {
  sheetId: number
  updates: { rowNumber: number; values: string[] }[]
  appends: string[][]
  existingRowCount: number
}

// `pasteData` column delimiter. Unit Separator (U+001F) — a control char
// that won't naturally appear in Stripe data. Row separator is always `\n`
// (not configurable), so any `\n`, `\r`, or U+001F inside cells must be
// sanitized or the paste parser misaligns columns.
export const PASTE_COL_DELIMITER = '\x1f'
const PASTE_SANITIZE_RE = /[\n\r\x1f]/g

function sanitizeForPaste(value: string): string {
  return value.replace(PASTE_SANITIZE_RE, ' ')
}

export function rowsToTsv(rows: string[][]): string {
  let out = ''
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    for (let c = 0; c < row.length; c++) {
      if (c > 0) out += PASTE_COL_DELIMITER
      out += sanitizeForPaste(row[c])
    }
    if (r < rows.length - 1) out += '\n'
  }
  return out
}

/**
 * Flush buffered updates + appends across all streams.
 *
 *   Phase 1  — parallel reads: gridProperties + per-stream row counts.
 *   Phase 3a — one batchUpdate with appendDimension requests (only if grids
 *              need to grow). Must precede data writes.
 *   Phase 3b — pasteData requests fan out into up to PARALLEL_BATCH_COUNT
 *              parallel batchUpdate calls. Wall-clock ≈ slowest chunk.
 *              PASTE_VALUES + TSV is the cheapest wire payload (no formula
 *              eval, no cell-level parsing server-side).
 *
 * Returns per-stream 1-based `appendStartRow` for row_assignments.
 */
export async function applyBatch(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  opsByStream: Map<string, StreamBatchOps>
): Promise<Map<string, { appendStartRow: number }>> {
  const applyStart = Date.now()

  // ── Phase 1 (parallel reads) ────────────────────────────────────
  // gridProperties for every sheet + per-stream column-A row counts when
  // we don't already have them (streams that bypassed buildRowMap).
  type GridInfo = { rowCount: number; columnCount: number }
  const gridInfo = new Map<number, GridInfo>()
  const probes: Array<Promise<void>> = []

  probes.push(
    (async () => {
      const metaStart = Date.now()
      try {
        const res = await withRetry(
          () =>
            sheets.spreadsheets.get({
              spreadsheetId,
              fields: 'sheets(properties(sheetId,gridProperties))',
            }),
          'gridMetadata'
        )
        for (const s of res.data.sheets ?? []) {
          const id = s.properties?.sheetId
          const gp = s.properties?.gridProperties
          if (id != null && gp) {
            gridInfo.set(id, { rowCount: gp.rowCount ?? 1000, columnCount: gp.columnCount ?? 26 })
          }
        }
        log.debug({ sheets: gridInfo.size, durationMs: Date.now() - metaStart }, 'gridMetadata')
      } catch (err) {
        log.warn({ err, durationMs: Date.now() - metaStart }, 'gridMetadata failed')
      }
    })()
  )

  for (const [streamName, ops] of opsByStream) {
    if (ops.appends.length > 0 && ops.existingRowCount === 0) {
      probes.push(
        (async () => {
          const probeStart = Date.now()
          try {
            const res = await withRetry(
              () =>
                sheets.spreadsheets.values.get({
                  spreadsheetId,
                  range: `'${streamName}'!A:A`,
                  majorDimension: 'ROWS',
                }),
              `rowCountProbe(${streamName})`
            )
            ops.existingRowCount = (res.data.values ?? []).length
            log.debug(
              {
                streamName,
                rows: ops.existingRowCount,
                durationMs: Date.now() - probeStart,
              },
              'rowCountProbe'
            )
          } catch (err) {
            log.warn(
              { err, streamName, durationMs: Date.now() - probeStart },
              'rowCountProbe failed'
            )
          }
        })()
      )
    }
  }
  const phase1Start = Date.now()
  await Promise.all(probes)
  log.debug(
    { parallelCalls: probes.length, durationMs: Date.now() - phase1Start },
    'phase1 (reads) done'
  )

  // ── Phase 2 (build payloads) ────────────────────────────────────
  // `expansionRequests` run first (Phase 3a) — the grid must fit before
  // pasteData writes. `dataRequests` run in parallel (Phase 3b) since each
  // pasteData targets a distinct row range.
  //
  // `PARALLEL_BATCH_COUNT` bounds HTTP fan-out AND row-slices each stream's
  // appends, so a single big stream can still fan out instead of bottlenecking
  // on one giant pasteData. Each data request carries its cell weight so the
  // Phase-3b bin-packer can balance chunks; wall-clock scales ~linearly with
  // cells per request.
  const PARALLEL_BATCH_COUNT = 4

  const appendStartRows = new Map<string, { appendStartRow: number }>()
  const expansionRequests: sheets_v4.Schema$Request[] = []
  const dataRequests: Array<{ request: sheets_v4.Schema$Request; cells: number }> = []
  const EXPAND_ROW_BUFFER = 1000

  // 2a) appendDimension — only for grids that don't already fit.
  const phase2aStart = Date.now()
  for (const [, ops] of opsByStream) {
    const maxUpdateRow = ops.updates.reduce((m, u) => Math.max(m, u.rowNumber), 0)
    const maxAppendRow = ops.appends.length > 0 ? ops.existingRowCount + ops.appends.length : 0
    const neededRows = Math.max(maxUpdateRow, maxAppendRow)

    const maxUpdateCol = ops.updates.reduce((m, u) => Math.max(m, u.values.length), 0)
    const maxAppendCol = ops.appends.reduce((m, row) => Math.max(m, row.length), 0)
    const neededCols = Math.max(maxUpdateCol, maxAppendCol)

    const current = gridInfo.get(ops.sheetId)
    if (!current) continue // metadata missing — best-effort; hope the grid fits

    if (neededRows > current.rowCount) {
      expansionRequests.push({
        appendDimension: {
          sheetId: ops.sheetId,
          dimension: 'ROWS',
          length: neededRows - current.rowCount + EXPAND_ROW_BUFFER,
        },
      })
    }
    if (neededCols > current.columnCount) {
      expansionRequests.push({
        appendDimension: {
          sheetId: ops.sheetId,
          dimension: 'COLUMNS',
          length: neededCols - current.columnCount,
        },
      })
    }
  }
  const expansionCount = expansionRequests.length
  log.debug(
    { expansions: expansionCount, durationMs: Date.now() - phase2aStart },
    'phase2a (expansions) planned'
  )

  // 2b) pasteData for contiguous update groups (one per group).
  //
  // DEBUG: updates suppressed while investigating flush perf. Flip to false
  // to re-enable; counters stay updated for logging parity.
  const DEBUG_SKIP_UPDATES = true
  const phase2bStart = Date.now()
  let updateGroupCount = 0
  let updateRowCount = 0
  let updateCellCount = 0
  let updateBytesEstimate = 0
  let skippedUpdateGroups = 0
  for (const [, ops] of opsByStream) {
    if (ops.updates.length === 0) continue
    const sortedUpdates = [...ops.updates].sort((a, b) => a.rowNumber - b.rowNumber)
    let groupStart = 0
    while (groupStart < sortedUpdates.length) {
      let groupEnd = groupStart
      while (
        groupEnd + 1 < sortedUpdates.length &&
        sortedUpdates[groupEnd + 1].rowNumber === sortedUpdates[groupEnd].rowNumber + 1
      ) {
        groupEnd++
      }
      const firstRow = sortedUpdates[groupStart].rowNumber
      let groupCells = 0
      const groupRows = sortedUpdates.slice(groupStart, groupEnd + 1).map((u) => {
        updateCellCount += u.values.length
        groupCells += u.values.length
        for (const v of u.values) updateBytesEstimate += v.length
        return u.values
      })
      if (DEBUG_SKIP_UPDATES) {
        skippedUpdateGroups++
      } else {
        dataRequests.push({
          request: {
            pasteData: {
              coordinate: { sheetId: ops.sheetId, rowIndex: firstRow - 1, columnIndex: 0 },
              data: rowsToTsv(groupRows),
              delimiter: PASTE_COL_DELIMITER,
              type: 'PASTE_VALUES',
            },
          },
          cells: groupCells,
        })
        updateGroupCount++
      }
      updateRowCount += groupEnd - groupStart + 1
      groupStart = groupEnd + 1
    }
  }
  if (DEBUG_SKIP_UPDATES && skippedUpdateGroups > 0) {
    log.debug(
      {
        skippedGroups: skippedUpdateGroups,
        rows: updateRowCount,
        cells: updateCellCount,
        bytes: updateBytesEstimate,
        durationMs: Date.now() - phase2bStart,
      },
      'phase2b (updates) skipped (DEBUG_SKIP_UPDATES)'
    )
  } else {
    log.debug(
      {
        groups: updateGroupCount,
        rows: updateRowCount,
        cells: updateCellCount,
        bytes: updateBytesEstimate,
        durationMs: Date.now() - phase2bStart,
      },
      'phase2b (updates) planned'
    )
  }

  // 2c) pasteData for appends. Slice each stream's block by cell count so
  // Phase 3b can balance evenly even when one big stream dominates (e.g.
  // `customers` ~10k rows). Each slice targets a distinct rowIndex, so
  // parallel writes hit non-overlapping rows. 100k cells ≈ 3-5 MB on
  // Stripe-shaped records and writes in ~1-2s.
  const APPEND_SLICE_CELLS_TARGET = 100_000
  const phase2cStart = Date.now()
  let appendGroupCount = 0
  let appendRowCount = 0
  let appendCellCount = 0
  let appendBytesEstimate = 0
  for (const [streamName, ops] of opsByStream) {
    if (ops.appends.length === 0) continue
    const startRow = ops.existingRowCount + 1
    const cols = ops.appends[0]?.length ?? 1
    for (const row of ops.appends) {
      appendCellCount += row.length
      for (const v of row) appendBytesEstimate += v.length
    }
    // Pick the smaller slice size so we (a) fan out across all PARALLEL_BATCH
    // chunks and (b) cap max slice size so the bin-packer can balance.
    const byCellsSliceRows = Math.max(1, Math.floor(APPEND_SLICE_CELLS_TARGET / Math.max(1, cols)))
    const byParallelismSliceRows = Math.max(1, Math.ceil(ops.appends.length / PARALLEL_BATCH_COUNT))
    const sliceRowSize = Math.min(byCellsSliceRows, byParallelismSliceRows)
    for (let offset = 0; offset < ops.appends.length; offset += sliceRowSize) {
      const slice = ops.appends.slice(offset, offset + sliceRowSize)
      const sliceCells = slice.reduce((sum, row) => sum + row.length, 0)
      dataRequests.push({
        request: {
          pasteData: {
            coordinate: {
              sheetId: ops.sheetId,
              rowIndex: startRow - 1 + offset,
              columnIndex: 0,
            },
            data: rowsToTsv(slice),
            delimiter: PASTE_COL_DELIMITER,
            type: 'PASTE_VALUES',
          },
        },
        cells: sliceCells,
      })
      appendGroupCount++
    }
    appendStartRows.set(streamName, { appendStartRow: startRow })
    appendRowCount += ops.appends.length
  }
  log.debug(
    {
      groups: appendGroupCount,
      rows: appendRowCount,
      cells: appendCellCount,
      bytes: appendBytesEstimate,
      durationMs: Date.now() - phase2cStart,
    },
    'phase2c (appends) planned'
  )

  if (expansionRequests.length === 0 && dataRequests.length === 0) return appendStartRows

  const totalCells = updateCellCount + appendCellCount
  const totalBytesEstimate = updateBytesEstimate + appendBytesEstimate

  // ── Phase 3a (grid expansion — runs first, only if needed) ─────
  if (expansionRequests.length > 0) {
    const expandStart = Date.now()
    try {
      const res = await withRetry(
        () =>
          sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: expansionRequests },
          }),
        'gridExpansion'
      )
      log.debug(
        {
          status: res.status,
          requests: expansionRequests.length,
          durationMs: Date.now() - expandStart,
        },
        'gridExpansion OK'
      )
    } catch (err) {
      log.error(
        { err, requests: expansionRequests.length, durationMs: Date.now() - expandStart },
        'gridExpansion FAILED'
      )
      throw err
    }
  }

  // ── Phase 3b (parallel data writes) ─────────────────────────────
  // Up to PARALLEL_BATCH_COUNT concurrent batchUpdate calls. Sheets accepts
  // parallel writes to distinct row ranges; wall-clock ≈ slowest chunk.
  //
  // Longest Processing Time (LPT) bin-packing on cell count: sort desc,
  // greedily assign each request to the least-loaded bin. Bounded by
  // (4/3 - 1/3m)× optimal makespan, near-optimal when a few large streams
  // dominate. Replaces the prior consecutive-index split which produced
  // wildly uneven chunks (heaviest had ~13× the work of the lightest).
  if (dataRequests.length === 0) return appendStartRows

  const binCount = Math.min(PARALLEL_BATCH_COUNT, dataRequests.length)
  type Bin = { requests: sheets_v4.Schema$Request[]; cells: number }
  const bins: Bin[] = Array.from({ length: binCount }, () => ({ requests: [], cells: 0 }))
  const sorted = [...dataRequests].sort((a, b) => b.cells - a.cells)
  for (const entry of sorted) {
    let minIdx = 0
    for (let i = 1; i < bins.length; i++) {
      if (bins[i].cells < bins[minIdx].cells) minIdx = i
    }
    bins[minIdx].requests.push(entry.request)
    bins[minIdx].cells += entry.cells
  }
  const chunks = bins.map((b) => b.requests)
  const chunkCells = bins.map((b) => b.cells)

  const minChunkCells = Math.min(...chunkCells)
  const maxChunkCells = Math.max(...chunkCells)
  const imbalanceRatio = minChunkCells === 0 ? Infinity : maxChunkCells / minChunkCells
  log.debug(
    {
      streams: opsByStream.size,
      totalRequests: dataRequests.length,
      parallelCalls: chunks.length,
      expansions: expansionCount,
      updateRows: updateRowCount,
      appendRows: appendRowCount,
      cells: totalCells,
      bytes: totalBytesEstimate,
      chunkCells,
      imbalanceRatio: Number(imbalanceRatio.toFixed(2)),
    },
    'batchUpdate dispatching'
  )

  const httpStart = Date.now()
  try {
    await Promise.all(
      chunks.map(async (chunk, idx) => {
        const chunkStart = Date.now()
        const chunkLabel = `batchUpdate[${idx + 1}/${chunks.length}]`
        const chunkCellCount = chunkCells[idx]
        try {
          const res = await withRetry(
            () =>
              sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: chunk },
              }),
            chunkLabel
          )
          const replyCount = res.data.replies?.length ?? 0
          log.debug(
            {
              label: chunkLabel,
              status: res.status,
              requests: chunk.length,
              cells: chunkCellCount,
              replies: replyCount,
              durationMs: Date.now() - chunkStart,
            },
            'batchUpdate chunk OK'
          )
        } catch (err) {
          log.error(
            {
              err,
              label: chunkLabel,
              requests: chunk.length,
              cells: chunkCellCount,
              durationMs: Date.now() - chunkStart,
            },
            'batchUpdate chunk FAILED'
          )
          throw err
        }
      })
    )
    const httpElapsed = Date.now() - httpStart
    log.debug(
      {
        chunks: chunks.length,
        totalRequests: dataRequests.length,
        wallClockMs: httpElapsed,
        applyBatchTotalMs: Date.now() - applyStart,
      },
      'batchUpdate OK (all parallel)'
    )
  } catch (err) {
    const httpElapsed = Date.now() - httpStart
    log.error(
      {
        err,
        chunks: chunks.length,
        totalRequests: dataRequests.length,
        expansions: expansionCount,
        updateRows: updateRowCount,
        appendRows: appendRowCount,
        cells: totalCells,
        wallClockMs: httpElapsed,
        applyBatchTotalMs: Date.now() - applyStart,
      },
      'batchUpdate FAILED (parallel)'
    )
    throw err
  }

  return appendStartRows
}
