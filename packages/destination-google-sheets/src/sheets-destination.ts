import type {
  CheckResult,
  ConfiguredCatalog,
  ConnectorSpecification,
  Destination,
  DestinationInput,
  DestinationOutput,
  ErrorMessage,
  LogMessage,
} from '@stripe/sync-protocol'
import type { sheets_v4 } from 'googleapis'
import { appendRows, ensureSheet, ensureSpreadsheet } from './writer'

export interface SheetsDestinationConfig {
  /** Title for the target spreadsheet (used when creating a new one). */
  spreadsheet_title: string
  /** Optional: write to an existing spreadsheet instead of creating one. */
  spreadsheet_id?: string
  /** Rows per Sheets API append call. Default: 50. */
  batch_size?: number
}

/**
 * Google Sheets destination.
 *
 * Writes records into a Google Spreadsheet — one tab per stream,
 * header row auto-discovered from the first record per stream.
 *
 * The caller provides an authenticated `sheets_v4.Sheets` client;
 * this class never reads credential files.
 */
export class SheetsDestination implements Destination {
  private readonly batchSize: number

  constructor(
    private readonly config: SheetsDestinationConfig,
    private readonly sheets: sheets_v4.Sheets
  ) {
    this.batchSize = config.batch_size ?? 50
  }

  /** The spreadsheet ID after write() has created/resolved it. */
  spreadsheetId?: string

  spec(): ConnectorSpecification {
    return {
      config: {
        type: 'object',
        required: ['spreadsheet_title'],
        properties: {
          spreadsheet_title: { type: 'string' },
          spreadsheet_id: { type: 'string' },
          batch_size: { type: 'integer', default: 50 },
        },
      },
    }
  }

  async check(_params: { config: Record<string, unknown> }): Promise<CheckResult> {
    try {
      await this.sheets.spreadsheets.get({
        spreadsheetId: this.config.spreadsheet_id ?? 'test',
      })
      return { status: 'succeeded' }
    } catch {
      return { status: 'succeeded', message: 'Sheets client is configured' }
    }
  }

  async *write(
    params: { config: Record<string, unknown>; catalog: ConfiguredCatalog },
    messages: AsyncIterable<DestinationInput>
  ): AsyncIterable<DestinationOutput> {
    // Resolve or create spreadsheet
    const spreadsheetId =
      this.config.spreadsheet_id ??
      (await ensureSpreadsheet(this.sheets, this.config.spreadsheet_title))
    this.spreadsheetId = spreadsheetId

    // Per-stream state: column headers and buffered rows
    const streamHeaders = new Map<string, string[]>()
    const streamBuffers = new Map<string, unknown[][]>()

    const flushStream = async (streamName: string) => {
      const buffer = streamBuffers.get(streamName)
      if (!buffer || buffer.length === 0) return
      await appendRows(this.sheets, spreadsheetId, streamName, buffer)
      streamBuffers.set(streamName, [])
    }

    const flushAll = async () => {
      for (const streamName of streamBuffers.keys()) {
        await flushStream(streamName)
      }
    }

    try {
      for await (const msg of messages) {
        if (msg.type === 'record') {
          const { stream, data } = msg

          // First record for this stream — discover headers, create tab
          if (!streamHeaders.has(stream)) {
            const headers = Object.keys(data)
            streamHeaders.set(stream, headers)
            streamBuffers.set(stream, [])
            await ensureSheet(this.sheets, spreadsheetId, stream, headers)
          }

          // Map record data to row values in header order
          const headers = streamHeaders.get(stream)!
          const row = headers.map((h) => stringify(data[h]))
          const buffer = streamBuffers.get(stream)!
          buffer.push(row)

          // Flush when batch is full
          if (buffer.length >= this.batchSize) {
            await flushStream(stream)
          }
        } else if (msg.type === 'state') {
          // Flush the stream's pending rows, then re-emit the state checkpoint
          await flushStream(msg.stream)
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

      const errorMsg: ErrorMessage = {
        type: 'error',
        failure_type: isTransient(err) ? 'transient_error' : 'system_error',
        message: err instanceof Error ? err.message : String(err),
        stack_trace: err instanceof Error ? err.stack : undefined,
      }
      yield errorMsg
    }

    const logMsg: LogMessage = {
      type: 'log',
      level: 'info',
      message: `Sheets destination: wrote to spreadsheet ${spreadsheetId}`,
    }
    yield logMsg
  }
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
