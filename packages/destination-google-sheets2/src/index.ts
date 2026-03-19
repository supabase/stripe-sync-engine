import { z } from 'zod'
import { google } from 'googleapis'
import type { sheets_v4 } from 'googleapis'
import type { Destination } from '@stripe/sync-protocol'

// MARK: - Spec

export const spec = z.object({
  client_id: z.string().describe('Google OAuth2 client ID'),
  client_secret: z.string().describe('Google OAuth2 client secret'),
  access_token: z.string().describe('OAuth2 access token'),
  refresh_token: z.string().describe('OAuth2 refresh token'),
  spreadsheet_id: z.string().describe('Target spreadsheet ID'),
})

export type Config = z.infer<typeof spec>

// MARK: - Helpers

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

function makeSheetsClient(config: Config): sheets_v4.Sheets {
  const auth = new google.auth.OAuth2(config.client_id, config.client_secret)
  auth.setCredentials({
    access_token: config.access_token,
    refresh_token: config.refresh_token,
  })
  return google.sheets({ version: 'v4', auth })
}

async function ensureSheet(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  streamName: string,
  headers: string[]
): Promise<void> {
  const meta = await withRetry(() =>
    sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' })
  )
  const existing = meta.data.sheets ?? []
  const existingNames = existing.map((s) => s.properties?.title)

  if (existingNames.includes(streamName)) {
    await writeHeaderRow(sheets, spreadsheetId, streamName, headers)
    return
  }

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
                properties: { sheetId: existing[0]!.properties!.sheetId!, title: streamName },
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
        requestBody: { requests: [{ addSheet: { properties: { title: streamName } } }] },
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

async function appendRows(
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

function stringify(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error) || !('code' in err)) return false
  const code = (err as { code: number }).code
  return code === 429 || code >= 500
}

// MARK: - Destination

const destination = {
  spec() {
    return { config: z.toJSONSchema(spec) }
  },

  async check({ config }) {
    try {
      const sheets = makeSheetsClient(config)
      await sheets.spreadsheets.get({
        spreadsheetId: config.spreadsheet_id,
        fields: 'spreadsheetId',
      })
      return { status: 'succeeded' as const }
    } catch (err: any) {
      return { status: 'failed' as const, message: err.message }
    }
  },

  async *write({ config, catalog }, $stdin) {
    const sheets = makeSheetsClient(config)
    const batchSize = 50
    const spreadsheetId = config.spreadsheet_id

    // Per-stream state: column headers and buffered rows
    const streamHeaders = new Map<string, string[]>()
    const streamBuffers = new Map<string, unknown[][]>()

    const flushStream = async (streamName: string) => {
      const buffer = streamBuffers.get(streamName)
      if (!buffer || buffer.length === 0) return
      await appendRows(sheets, spreadsheetId, streamName, buffer)
      streamBuffers.set(streamName, [])
    }

    const flushAll = async () => {
      for (const streamName of streamBuffers.keys()) {
        await flushStream(streamName)
      }
    }

    try {
      for await (const msg of $stdin) {
        if (msg.type === 'state') {
          await flushStream(msg.stream)
          yield msg
          continue
        }
        if (msg.type !== 'record') continue

        const { stream, data } = msg

        // First record for this stream — discover headers, create tab
        if (!streamHeaders.has(stream)) {
          const headers = Object.keys(data)
          streamHeaders.set(stream, headers)
          streamBuffers.set(stream, [])
          await ensureSheet(sheets, spreadsheetId, stream, headers)
        }

        // Map record data to row values in header order
        const headers = streamHeaders.get(stream)!
        const row = headers.map((h) => stringify(data[h]))
        const buffer = streamBuffers.get(stream)!
        buffer.push(row)

        if (buffer.length >= batchSize) {
          await flushStream(stream)
        }
      }

      await flushAll()
    } catch (err: unknown) {
      try {
        await flushAll()
      } catch {
        // ignore flush errors during error handling
      }

      const failure_type = isTransient(err)
        ? ('transient_error' as const)
        : ('system_error' as const)
      yield {
        type: 'error' as const,
        failure_type,
        message: err instanceof Error ? err.message : String(err),
        stack_trace: err instanceof Error ? err.stack : undefined,
      }
    }

    yield {
      type: 'log' as const,
      level: 'info' as const,
      message: `Sheets destination: wrote to spreadsheet ${spreadsheetId}`,
    }
  },
} satisfies Destination<Config>

export default destination
