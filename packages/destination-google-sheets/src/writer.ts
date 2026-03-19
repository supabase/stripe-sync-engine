import type { sheets_v4 } from 'googleapis'

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
 */
export async function ensureSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  streamName: string,
  headers: string[]
): Promise<void> {
  // Get existing sheets
  const meta = await withRetry(() =>
    sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties',
    })
  )
  const existing = meta.data.sheets ?? []
  const existingNames = existing.map((s) => s.properties?.title)

  if (existingNames.includes(streamName)) {
    // Tab already exists — write header row in case it's empty
    await writeHeaderRow(sheets, spreadsheetId, streamName, headers)
    return
  }

  // If there's a default "Sheet1" and this is the first real stream, rename it
  if (
    existing.length === 1 &&
    existing[0]?.properties?.title === 'Sheet1' &&
    existing[0]?.properties?.sheetId !== undefined
  ) {
    await withRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: {
                  sheetId: existing[0]!.properties!.sheetId!,
                  title: streamName,
                },
                fields: 'title',
              },
            },
          ],
        },
      })
    )
  } else {
    // Add a new tab
    await withRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: streamName } } }],
        },
      })
    )
  }

  await writeHeaderRow(sheets, spreadsheetId, streamName, headers)
}

async function writeHeaderRow(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  headers: string[]
): Promise<void> {
  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    })
  )
}

/** Append rows to a named sheet tab. Values are stringified for Sheets. */
export async function appendRows(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetName: string,
  rows: unknown[][]
): Promise<void> {
  if (rows.length === 0) return

  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${sheetName}'!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    })
  )
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
