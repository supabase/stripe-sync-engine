import type { drive_v3, sheets_v4 } from 'googleapis'

/**
 * Low-level Sheets API write operations.
 *
 * Takes an already-authenticated `sheets_v4.Sheets` client (injected by caller).
 * Handles spreadsheet creation, tab management, header rows, and batch appends.
 */

const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 32000
const MAX_RETRIES = 5

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let delay = BACKOFF_BASE_MS
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      const status =
        err instanceof Error && 'code' in err ? (err as { code: number }).code : undefined
      const isRateLimit = status === 429
      const isServerError = status !== undefined && status >= 500

      if ((isRateLimit || isServerError) && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(delay * 2, BACKOFF_MAX_MS)
        continue
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
  const rows = [
    ['Stripe Sync Engine'],
    [''],
    ['This spreadsheet is managed by Stripe Sync Engine.'],
    ['Data is synced automatically from your Stripe account.'],
    [''],
    ['Synced streams:'],
    ...streamNames.map((name) => [`  • ${name}`]),
    [''],
    [`Last setup: ${now}`],
    [''],
    ['⚠️  Do not edit data in the synced tabs. Changes will be overwritten on the next sync.'],
  ]

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${TITLE}'!A1`,
      valueInputOption: 'RAW',
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

  for (const update of updates) {
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${sheetName}'!A${update.rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [update.values] },
      })
    )
  }
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
