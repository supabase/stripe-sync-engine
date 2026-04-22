import type { drive_v3, sheets_v4 } from 'googleapis'
import { log } from './logger.js'
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
export async function createSpreadsheet(sheets: sheets_v4.Sheets, title: string): Promise<string> {
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

/** Metadata returned by {@link getSpreadsheetMeta} for reuse across setup steps. */
export interface SpreadsheetMeta {
  sheets: Array<{
    title: string
    sheetId: number
    hasProtection: boolean
  }>
}

/** Fetch spreadsheet metadata once for reuse by ensureSheets, ensureIntroSheet, protectSheets. */
export async function getSpreadsheetMeta(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string
): Promise<SpreadsheetMeta> {
  const meta = await withRetry(
    () =>
      sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets(properties(sheetId,title),protectedRanges(protectedRangeId))',
      }),
    'getSpreadsheetMeta'
  )
  return {
    sheets: (meta.data.sheets ?? []).map((s) => ({
      title: s.properties?.title ?? '',
      sheetId: s.properties?.sheetId ?? 0,
      hasProtection: (s.protectedRanges ?? []).length > 0,
    })),
  }
}

/**
 * Ensure tabs exist for all streams in one pass.
 *
 * 1. Uses pre-fetched metadata to find existing/missing tabs.
 * 2. Creates all missing tabs in a single batchUpdate (renames Sheet1 for first if present).
 * 3. Writes all header rows in a single values.batchUpdate.
 *
 * Returns a Map of stream name → numeric sheetId.
 */
export async function ensureSheets(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  meta: SpreadsheetMeta,
  streamHeaders: Array<{ streamName: string; headers: string[] }>
): Promise<Map<string, number>> {
  const existingByName = new Map(meta.sheets.map((s) => [s.title, s.sheetId]))
  const result = new Map<string, number>()
  const toCreate: string[] = []

  for (const { streamName } of streamHeaders) {
    const existingId = existingByName.get(streamName)
    if (existingId !== undefined) {
      result.set(streamName, existingId)
    } else {
      toCreate.push(streamName)
    }
  }

  if (toCreate.length > 0) {
    const requests: sheets_v4.Schema$Request[] = []
    let renamedSheet1 = false

    // Rename Sheet1 for the first missing tab if available
    const sheet1 = meta.sheets.find((s) => s.title === 'Sheet1')
    if (sheet1) {
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: sheet1.sheetId, title: toCreate[0] },
          fields: 'title',
        },
      })
      result.set(toCreate[0], sheet1.sheetId)
      renamedSheet1 = true
    }

    const startIdx = renamedSheet1 ? 1 : 0
    for (let i = startIdx; i < toCreate.length; i++) {
      requests.push({ addSheet: { properties: { title: toCreate[i] } } })
    }

    const res = await withRetry(
      () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests },
        }),
      'ensureSheets:create'
    )

    const replies = res.data.replies ?? []
    let replyIdx = renamedSheet1 ? 1 : 0
    for (let i = startIdx; i < toCreate.length; i++) {
      const sheetId = replies[replyIdx]?.addSheet?.properties?.sheetId
      if (sheetId == null) {
        throw new Error(`Failed to get sheetId for new sheet "${toCreate[i]}"`)
      }
      result.set(toCreate[i], sheetId)
      replyIdx++
    }
  }

  // Write all header rows in one values.batchUpdate
  const headerData = streamHeaders
    .filter(({ headers }) => headers.length > 0)
    .map(({ streamName, headers }) => ({
      range: `'${streamName}'!A1`,
      values: [headers],
    }))

  if (headerData.length > 0) {
    await withRetry(
      () =>
        sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: 'RAW', data: headerData },
        }),
      'ensureSheets:headers'
    )
  }

  return result
}

/**
 * Ensure a single tab exists with a header row.
 * Used by the write path for on-demand tab creation (new stream or header change).
 * For bulk setup, prefer {@link ensureSheets}.
 */
export async function ensureSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  streamName: string,
  headers: string[]
): Promise<number> {
  const meta = await getSpreadsheetMeta(sheets, spreadsheetId)
  const result = await ensureSheets(sheets, spreadsheetId, meta, [{ streamName, headers }])
  return result.get(streamName)!
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
export async function ensureIntroSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  meta: SpreadsheetMeta,
  streamNames: string[]
): Promise<void> {
  const TITLE = 'Overview'
  const hasOverview = meta.sheets.some((s) => s.title === TITLE)

  if (!hasOverview) {
    // Rename "Sheet1" if it's the only tab, otherwise insert at index 0
    const sheet1 = meta.sheets.find((s) => s.title === 'Sheet1')
    if (meta.sheets.length === 1 && sheet1) {
      await withRetry(() =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                updateSheetProperties: {
                  properties: { sheetId: sheet1.sheetId, title: TITLE },
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
 * Add warning-only protection to sheets that don't already have it.
 * Uses pre-fetched metadata to skip already-protected sheets and batches
 * all `addProtectedRange` requests into a single API call.
 */
export async function protectSheets(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  meta: SpreadsheetMeta,
  sheetIds: number[]
): Promise<void> {
  const alreadyProtected = new Set(
    meta.sheets.filter((s) => s.hasProtection).map((s) => s.sheetId)
  )
  const requests: sheets_v4.Schema$Request[] = []
  for (const sheetId of sheetIds) {
    if (alreadyProtected.has(sheetId)) continue
    requests.push({
      addProtectedRange: {
        protectedRange: {
          range: { sheetId },
          description: 'Managed by Stripe Sync Engine — edits may be overwritten on next sync',
          warningOnly: true,
        },
      },
    })
  }
  if (requests.length === 0) return
  await withRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      }),
    'protectSheets'
  )
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

  // Skip header row (index 0), data starts at index 1
  const map = new Map<string, number>()
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
 * Like `buildRowMapFromRows` but for a header-less PK-only slice
 * (see `batchReadSheets` with `columnCount`). Row i → sheet row i + 2.
 */
export function buildRowMapFromPkColumns(
  pkRows: unknown[][],
  primaryKey: string[][]
): Map<string, number> {
  const pkFields = primaryKey.map((path) => path[0])
  const map = new Map<string, number>()
  for (let i = 0; i < pkRows.length; i++) {
    const row = pkRows[i] as string[]
    const data: Record<string, unknown> = {}
    for (let j = 0; j < pkFields.length; j++) {
      data[pkFields[j]] = row[j] ?? ''
    }
    const rowKey = serializeRowKey(primaryKey, data)
    if (rowKey === '[""]' || rowKey === '[null]') continue
    map.set(rowKey, i + 2)
  }
  return map
}

/**
 * Build a map from serialized primary key → 1-based row number by reading
 * existing sheet data and extracting only the primary key columns.
 *
 * `headers` must already be known (from `readHeaderRow` or first-record discovery).
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

function columnLetter(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }
  return label
}

export interface BatchReadRequest {
  name: string
  /** Read only the first N columns starting at row 2 (header skipped). */
  columnCount?: number
}

/**
 * Read multiple sheet tabs in one `values.batchGet` call. Replaces N
 * parallel reads with 1 request and 1 read-quota unit — required for wide
 * catalogs (otherwise blows the 300/min read limit). Missing tabs map to
 * empty arrays so callers can always `.get()` safely.
 *
 * With `columnCount` set: response is PK-only, header-less — use with
 * {@link buildRowMapFromPkColumns}. Without: whole tab — use with
 * {@link buildRowMapFromRows}.
 */
export async function batchReadSheets(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  requests: Array<string | BatchReadRequest>
): Promise<Map<string, unknown[][]>> {
  const result = new Map<string, unknown[][]>()
  if (requests.length === 0) return result
  const normalized = requests.map((r) => (typeof r === 'string' ? { name: r } : r))
  const res = await withRetry(() =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: normalized.map((req) =>
        req.columnCount && req.columnCount > 0
          ? `'${req.name}'!A2:${columnLetter(req.columnCount - 1)}`
          : `'${req.name}'`
      ),
    })
  )
  const valueRanges = res.data.valueRanges ?? []
  for (let i = 0; i < normalized.length; i++) {
    const entry = valueRanges[i]
    const values = (entry?.values ?? []) as unknown[][]
    result.set(normalized[i].name, values)
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
 *   Phase 3b — one batchUpdate with all pasteData requests. PASTE_VALUES +
 *              TSV is the cheapest wire payload (no formula eval, no
 *              cell-level parsing server-side).
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
  log.warn(
    { parallelCalls: probes.length, durationMs: Date.now() - phase1Start },
    'phase1 (reads) done'
  )

  // ── Phase 2 (build payloads) ────────────────────────────────────
  // `expansionRequests` run first (Phase 3a) — the grid must fit before
  // pasteData writes. `dataRequests` are all dispatched in one batchUpdate
  // (Phase 3b); each pasteData targets a distinct row range on its sheet.
  const appendStartRows = new Map<string, { appendStartRow: number }>()
  const expansionRequests: sheets_v4.Schema$Request[] = []
  const dataRequests: sheets_v4.Schema$Request[] = []
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
  const phase2bStart = Date.now()
  let updateGroupCount = 0
  let updateRowCount = 0
  let updateCellCount = 0
  let updateBytesEstimate = 0
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
      dataRequests.push({
        pasteData: {
          coordinate: { sheetId: ops.sheetId, rowIndex: firstRow - 1, columnIndex: 0 },
          data: rowsToTsv(groupRows),
          delimiter: PASTE_COL_DELIMITER,
          type: 'PASTE_VALUES',
        },
      })
      updateGroupCount++
      updateRowCount += groupEnd - groupStart + 1
      groupStart = groupEnd + 1
    }
  }
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

  // 2c) pasteData for appends — one request per stream.
  const phase2cStart = Date.now()
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
    dataRequests.push({
      pasteData: {
        coordinate: { sheetId: ops.sheetId, rowIndex: startRow - 1, columnIndex: 0 },
        data: rowsToTsv(ops.appends),
        delimiter: PASTE_COL_DELIMITER,
        type: 'PASTE_VALUES',
      },
    })
    appendStartRows.set(streamName, { appendStartRow: startRow })
    appendRowCount += ops.appends.length
  }
  log.warn(
    {
      streams: appendStartRows.size,
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
      log.warn(
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

  // ── Phase 3b (single batchUpdate with all data writes) ──────────
  if (dataRequests.length === 0) return appendStartRows

  log.warn(
    {
      streams: opsByStream.size,
      totalRequests: dataRequests.length,
      expansions: expansionCount,
      updateRows: updateRowCount,
      appendRows: appendRowCount,
      cells: totalCells,
      bytes: totalBytesEstimate,
    },
    'batchUpdate dispatching'
  )

  const httpStart = Date.now()
  try {
    const res = await withRetry(
      () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: dataRequests },
        }),
      'batchUpdate'
    )
    log.debug(
      {
        status: res.status,
        requests: dataRequests.length,
        cells: totalCells,
        replies: res.data.replies?.length ?? 0,
        wallClockMs: Date.now() - httpStart,
        applyBatchTotalMs: Date.now() - applyStart,
      },
      'batchUpdate OK'
    )
  } catch (err) {
    log.error(
      {
        err,
        totalRequests: dataRequests.length,
        expansions: expansionCount,
        updateRows: updateRowCount,
        appendRows: appendRowCount,
        cells: totalCells,
        wallClockMs: Date.now() - httpStart,
        applyBatchTotalMs: Date.now() - applyStart,
      },
      'batchUpdate FAILED'
    )
    throw err
  }

  return appendStartRows
}
