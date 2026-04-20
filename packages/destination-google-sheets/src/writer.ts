import type { drive_v3, sheets_v4 } from 'googleapis'
import { serializeRowKey } from './metadata.js'

/**
 * Low-level Sheets API write operations.
 *
 * Takes an already-authenticated `sheets_v4.Sheets` client (injected by caller).
 * Handles spreadsheet creation, tab management, header rows, and batch appends.
 */

const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 32000
const MAX_RETRIES = 5

async function withRetry<T>(fn: () => Promise<T>, label?: string): Promise<T> {
  let delay = BACKOFF_BASE_MS
  const overallStart = Date.now()
  if (label) {
    console.error(`[google-sheets] withRetry(${label}) start`)
  }
  for (let attempt = 0; ; attempt++) {
    const attemptStart = Date.now()
    try {
      const result = await fn()
      if (label) {
        const attemptMs = Date.now() - attemptStart
        const totalMs = Date.now() - overallStart
        if (attempt === 0) {
          console.error(`[google-sheets] withRetry(${label}) OK first-try in ${attemptMs}ms`)
        } else {
          console.error(
            `[google-sheets] withRetry(${label}) OK after ${attempt + 1} attempts (last=${attemptMs}ms, total=${totalMs}ms)`
          )
        }
      }
      return result
    } catch (err: unknown) {
      const attemptMs = Date.now() - attemptStart
      const rawCode =
        err instanceof Error && 'code' in err
          ? (err as { code?: number | string }).code
          : undefined
      const status = typeof rawCode === 'number' ? rawCode : undefined
      const isRateLimit = status === 429
      const isServerError = status !== undefined && status >= 500
      const retriable = isRateLimit || isServerError
      const errMsg = err instanceof Error ? err.message : String(err)

      if (retriable && attempt < MAX_RETRIES) {
        if (label) {
          console.error(
            `[google-sheets] withRetry(${label}) retry attempt=${attempt + 1}/${MAX_RETRIES} status=${status} attempt_ms=${attemptMs} backing_off_ms=${delay} err=${errMsg}`
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
        console.error(
          `[google-sheets] withRetry(${label}) FAIL ${reason} after ${attempt + 1} attempts (last=${attemptMs}ms, total=${totalMs}ms) err=${errMsg}`
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
 * Ensure a tab (sheet) exists for a given stream name with a header row.
 * If the spreadsheet already has a "Sheet1" default tab, rename it for the first stream.
 * Returns the numeric sheetId for use in subsequent API calls (e.g. protect range).
 */
export async function ensureSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  streamName: string,
  headers: string[]
): Promise<number> {
  // Get existing sheets
  const meta = await withRetry(() =>
    sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties',
    })
  )
  const existing = meta.data.sheets ?? []

  // Tab already exists — write header row and return its ID
  const found = existing.find((s) => s.properties?.title === streamName)
  if (found) {
    await writeHeaderRow(sheets, spreadsheetId, streamName, headers)
    return found.properties!.sheetId!
  }

  // If there's a default "Sheet1" and this is the first real stream, rename it
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

  // Add a new tab and capture its sheetId from the response
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

/**
 * Create or update an "Overview" intro tab at index 0.
 * Lists the synced streams and warns users not to edit data tabs.
 */
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
    // Rename "Sheet1" if it's the only tab, otherwise insert at index 0
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
 * Add warning-only protection to a set of sheets by their numeric sheetIds.
 * Users will see a warning dialog before editing but are not blocked.
 * Idempotent — skips sheets that already have protection.
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

/** Append rows to a named sheet tab. Values are stringified for Sheets. */
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

/**
 * Update specific rows in a sheet by their 1-based row numbers.
 * Uses a single batchUpdate call for efficiency.
 */
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

/**
 * Permanently delete a spreadsheet file via the Drive API.
 * The Sheets API does not support deletion — Drive is required.
 */
export async function deleteSpreadsheet(
  drive: drive_v3.Drive,
  spreadsheetId: string
): Promise<void> {
  await withRetry(() => drive.files.delete({ fileId: spreadsheetId }))
}

/**
 * Pure builder: serialized primary key → 1-based row number, derived from
 * already-fetched sheet rows. Use this after a single `readSheet` call when
 * you also want the row data for other purposes — avoids the double-read
 * that `buildRowMap` would otherwise incur.
 *
 * `headers` must already be known (from `readHeaderRow` or first-record discovery).
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
  // Skip header row (index 0), data starts at index 1
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i] as string[]
    const data: Record<string, unknown> = {}
    for (let j = 0; j < pkFields.length; j++) {
      data[pkFields[j]] = row[pkIndices[j]] ?? ''
    }
    const rowKey = serializeRowKey(primaryKey, data)
    if (rowKey === '[""]' || rowKey === '[null]') continue
    map.set(rowKey, i + 1) // 1-based: row 1 = headers, so data row at index i → row i+1
  }
  return map
}

/**
 * Read the sheet and build a map from serialized primary key → 1-based row
 * number. Thin wrapper over `readSheet` + `buildRowMapFromRows`. Prefer
 * `buildRowMapFromRows` directly if you already have the rows in hand.
 */
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

/** Read all values from a sheet tab. Used for verification in tests. */
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

export interface StreamBatchOps {
  sheetId: number
  updates: { rowNumber: number; values: string[] }[]
  appends: string[][]
  existingRowCount: number
}

// `pasteData` column delimiter. Unit Separator (U+001F / `\x1f`) is an ASCII
// control char that should never appear in Stripe data (JSON-stringified
// values, object IDs, timestamps, names, descriptions, etc.). Rows are
// separated by `\n` which is NOT configurable on `pasteData` — so we must
// sanitize any `\n`, `\r`, or `PASTE_COL_DELIMITER` that appears inside cell
// values to keep the paste parser from misaligning columns.
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

function describeError(err: unknown): string {
  const code =
    err instanceof Error && 'code' in err ? (err as { code?: number | string }).code : undefined
  const errors =
    err instanceof Error && 'errors' in err
      ? ((err as { errors?: unknown }).errors as unknown[])
      : undefined
  const message = err instanceof Error ? err.message : String(err)
  return `code=${code ?? 'unknown'} message=${message}${errors ? ` errors=${JSON.stringify(errors)}` : ''}`
}

/**
 * Flush buffered updates and appends across ALL streams. The call flow is:
 *
 *   Phase 1 (parallel structural reads) — `gridProperties` for every sheet,
 *     plus column-A row counts for any non-PK stream with appends.
 *   Phase 3a (grid expansion, conditional) — ONE `spreadsheets.batchUpdate`
 *     with only `appendDimension` requests, fired ONLY when some sheet's
 *     grid doesn't already fit. Skipped entirely when grids are roomy.
 *   Phase 3b (parallel data writes) — `pasteData` requests (one per update
 *     group + one per append stream) are split into up to
 *     `PARALLEL_BATCH_COUNT` chunks and fired concurrently via
 *     `Promise.all`. Each chunk is its own `spreadsheets.batchUpdate` HTTP
 *     call. Wall-clock approaches the slowest single chunk rather than the
 *     sum of all serialized work. `pasteData` with `PASTE_VALUES` sends raw
 *     `\x1f`-delimited TSV strings — the cheapest wire payload available,
 *     and server-side it skips formula evaluation and cell-level parsing.
 *
 * Returns the 1-based `appendStartRow` per stream so the caller can emit
 * row_key → row_number assignments.
 */
export async function applyBatch(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  opsByStream: Map<string, StreamBatchOps>
): Promise<Map<string, { appendStartRow: number }>> {
  const applyStart = Date.now()

  // ── Phase 1 (parallel reads) ────────────────────────────────────
  // Resolve `existingRowCount` for any stream with appends that didn't go
  // through `buildRowMap`, and fetch current `gridProperties` for every sheet
  // so we know which grids need to grow.
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
        console.error(
          `[google-sheets] gridMetadata: ${gridInfo.size} sheets in ${Date.now() - metaStart}ms`
        )
      } catch (err) {
        console.error(
          `[google-sheets] gridMetadata failed in ${Date.now() - metaStart}ms: ${describeError(err)}`
        )
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
            console.error(
              `[google-sheets] rowCountProbe(${streamName}): ${ops.existingRowCount} rows in ${Date.now() - probeStart}ms`
            )
          } catch (err) {
            console.error(
              `[google-sheets] rowCountProbe(${streamName}) failed in ${Date.now() - probeStart}ms: ${describeError(err)}`
            )
          }
        })()
      )
    }
  }
  const phase1Start = Date.now()
  await Promise.all(probes)
  console.error(
    `[google-sheets] phase1 (reads) done: ${probes.length} parallel calls in ${Date.now() - phase1Start}ms (wall clock, max of all probes)`
  )

  // ── Phase 2 (build payloads) ────────────────────────────────────
  // Two output containers:
  //   `expansionRequests` — structural `appendDimension` requests that MUST
  //     complete before the data writes (the grid has to fit first).
  //   `dataRequests` — pasteData requests for updates + appends. These can
  //     be split into multiple parallel `spreadsheets.batchUpdate` HTTP calls
  //     since pasteData operations target distinct, non-overlapping ranges.
  // Cap on parallel HTTP fan-out for the data write. Also used in Phase 2
  // to row-slice each stream's appends so a single-stream flush can still
  // fan out across multiple parallel `batchUpdate` calls instead of
  // bottlenecking on one giant pasteData.
  const PARALLEL_BATCH_COUNT = 4

  const appendStartRows = new Map<string, { appendStartRow: number }>()
  const expansionRequests: sheets_v4.Schema$Request[] = []
  const dataRequests: sheets_v4.Schema$Request[] = []
  const EXPAND_ROW_BUFFER = 1000

  // 2a) appendDimension requests — only for sheets whose grid doesn't already fit
  const phase2aStart = Date.now()
  for (const [, ops] of opsByStream) {
    const maxUpdateRow = ops.updates.reduce((m, u) => Math.max(m, u.rowNumber), 0)
    const maxAppendRow = ops.appends.length > 0 ? ops.existingRowCount + ops.appends.length : 0
    const neededRows = Math.max(maxUpdateRow, maxAppendRow)

    const maxUpdateCol = ops.updates.reduce((m, u) => Math.max(m, u.values.length), 0)
    const maxAppendCol = ops.appends.reduce((m, row) => Math.max(m, row.length), 0)
    const neededCols = Math.max(maxUpdateCol, maxAppendCol)

    const current = gridInfo.get(ops.sheetId)
    if (!current) continue // metadata missing — best-effort; fall through and hope grid fits

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
  console.error(
    `[google-sheets] phase2a (expansions): ${expansionCount} appendDimension requests in ${Date.now() - phase2aStart}ms`
  )

  // 2b) pasteData requests for contiguous update groups (one per group).
  //
  // DEBUG: updates are temporarily disabled to isolate the append path while
  // investigating flush performance. Buffered updates are still counted (for
  // logging parity) but NOT pushed into `dataRequests[]`. Flip
  // `DEBUG_SKIP_UPDATES` to `false` to re-enable, or remove the guard when
  // done debugging.
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
      const groupRows = sortedUpdates.slice(groupStart, groupEnd + 1).map((u) => {
        updateCellCount += u.values.length
        for (const v of u.values) updateBytesEstimate += v.length
        return u.values
      })
      if (DEBUG_SKIP_UPDATES) {
        skippedUpdateGroups++
      } else {
        dataRequests.push({
          pasteData: {
            coordinate: { sheetId: ops.sheetId, rowIndex: firstRow - 1, columnIndex: 0 },
            data: rowsToTsv(groupRows),
            delimiter: PASTE_COL_DELIMITER,
            type: 'PASTE_VALUES',
          },
        })
        updateGroupCount++
      }
      updateRowCount += groupEnd - groupStart + 1
      groupStart = groupEnd + 1
    }
  }
  if (DEBUG_SKIP_UPDATES && skippedUpdateGroups > 0) {
    console.error(
      `[google-sheets] phase2b (updates): DEBUG_SKIP_UPDATES=true — skipped ${skippedUpdateGroups} pasteData groups, ${updateRowCount} rows, ${updateCellCount} cells, ~${Math.round(updateBytesEstimate / 1024)}KB values (would-have-taken ${Date.now() - phase2bStart}ms to build)`
    )
  } else {
    console.error(
      `[google-sheets] phase2b (updates): ${updateGroupCount} pasteData groups, ${updateRowCount} rows, ${updateCellCount} cells, ~${Math.round(updateBytesEstimate / 1024)}KB values in ${Date.now() - phase2bStart}ms`
    )
  }

  // 2c) pasteData requests for appends. To enable 4-way parallel dispatch
  //     in Phase 3b even on single-stream flushes, slice each stream's
  //     append block into up to `PARALLEL_BATCH_COUNT` row-ranges (disjoint,
  //     contiguous). Each slice targets its own `coordinate.rowIndex`, so
  //     Google writes them to non-overlapping rows and they can run fully
  //     in parallel with no data loss.
  const phase2cStart = Date.now()
  let appendGroupCount = 0
  let appendRowCount = 0
  let appendCellCount = 0
  let appendBytesEstimate = 0
  for (const [streamName, ops] of opsByStream) {
    if (ops.appends.length === 0) continue
    const startRow = ops.existingRowCount + 1
    for (const row of ops.appends) {
      appendCellCount += row.length
      for (const v of row) appendBytesEstimate += v.length
    }
    const sliceSize = Math.max(1, Math.ceil(ops.appends.length / PARALLEL_BATCH_COUNT))
    for (let offset = 0; offset < ops.appends.length; offset += sliceSize) {
      const slice = ops.appends.slice(offset, offset + sliceSize)
      dataRequests.push({
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
      })
      appendGroupCount++
    }
    appendStartRows.set(streamName, { appendStartRow: startRow })
    appendRowCount += ops.appends.length
  }
  console.error(
    `[google-sheets] phase2c (appends): ${appendGroupCount} pasteData groups, ${appendRowCount} rows, ${appendCellCount} cells, ~${Math.round(appendBytesEstimate / 1024)}KB values in ${Date.now() - phase2cStart}ms`
  )

  if (expansionRequests.length === 0 && dataRequests.length === 0) return appendStartRows

  const totalCells = updateCellCount + appendCellCount
  const totalBytesEstimate = updateBytesEstimate + appendBytesEstimate

  // ── Phase 3a (grid expansion — only when needed, runs first) ────
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
      console.error(
        `[google-sheets] gridExpansion OK: status=${res.status} requests=${expansionRequests.length} elapsed=${Date.now() - expandStart}ms`
      )
    } catch (err) {
      console.error(
        `[google-sheets] gridExpansion FAILED after ${Date.now() - expandStart}ms (${expansionRequests.length} requests): ${describeError(err)}`
      )
      throw err
    }
  }

  // ── Phase 3b (parallel data writes) ─────────────────────────────
  // Split the pasteData requests across up to PARALLEL_BATCH_COUNT HTTP
  // calls, fired concurrently via Promise.all. Google Sheets happily
  // accepts several concurrent batchUpdate calls against the same
  // spreadsheet — each one targets distinct rows, no ordering required
  // between them. Total wall-clock drops toward the slowest individual
  // call instead of the sum of all serialized work.
  if (dataRequests.length === 0) return appendStartRows

  const chunkSize = Math.ceil(dataRequests.length / PARALLEL_BATCH_COUNT)
  const chunks: sheets_v4.Schema$Request[][] = []
  for (let i = 0; i < dataRequests.length; i += chunkSize) {
    chunks.push(dataRequests.slice(i, i + chunkSize))
  }

  console.error(
    `[google-sheets] batchUpdate dispatching: streams=${opsByStream.size} total_requests=${dataRequests.length} split_across=${chunks.length} parallel_calls (expansions_done=${expansionCount}, updateRows=${updateRowCount}, appendRows=${appendRowCount}) cells=${totalCells} values~${Math.round(totalBytesEstimate / 1024)}KB`
  )

  const httpStart = Date.now()
  try {
    await Promise.all(
      chunks.map(async (chunk, idx) => {
        const chunkStart = Date.now()
        const chunkLabel = `batchUpdate[${idx + 1}/${chunks.length}]`
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
          console.error(
            `[google-sheets] ${chunkLabel} OK: status=${res.status} requests=${chunk.length} replies=${replyCount} elapsed=${Date.now() - chunkStart}ms`
          )
        } catch (err) {
          console.error(
            `[google-sheets] ${chunkLabel} FAILED after ${Date.now() - chunkStart}ms (${chunk.length} requests): ${describeError(err)}`
          )
          throw err
        }
      })
    )
    const httpElapsed = Date.now() - httpStart
    console.error(
      `[google-sheets] batchUpdate OK (all parallel): chunks=${chunks.length} total_requests=${dataRequests.length} wall_clock=${httpElapsed}ms applyBatch_total=${Date.now() - applyStart}ms`
    )
  } catch (err) {
    const httpElapsed = Date.now() - httpStart
    console.error(
      `[google-sheets] batchUpdate FAILED (parallel) after ${httpElapsed}ms applyBatch_total=${Date.now() - applyStart}ms (chunks=${chunks.length} total_requests=${dataRequests.length} expansions=${expansionCount} updateRows=${updateRowCount} appendRows=${appendRowCount} cells=${totalCells}): ${describeError(err)}`
    )
    throw err
  }

  return appendStartRows
}
