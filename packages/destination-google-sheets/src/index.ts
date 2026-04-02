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
import { google } from 'googleapis'
import { z } from 'zod'
import { configSchema } from './spec.js'
import type { Config } from './spec.js'
import { appendRows, ensureSheet, ensureSpreadsheet } from './writer.js'

export { ensureSpreadsheet, ensureSheet, appendRows, readSheet } from './writer.js'

// MARK: - Spec

export { configSchema, envVars, type Config } from './spec.js'

// MARK: - Helpers

function makeSheetsClient(config: Config) {
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
  return google.sheets({ version: 'v4', auth })
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

// MARK: - Destination

/**
 * Create a Google Sheets destination.
 *
 * Pass a `sheetsClient` to inject a fake for testing; omit it for production
 * (each method creates a real client from config credentials).
 */
export function createDestination(
  sheetsClient?: sheets_v4.Sheets
): Destination<Config> & { readonly spreadsheetId: string | undefined } {
  let spreadsheetId: string | undefined

  const destination = {
    /** The spreadsheet ID after write() has created/resolved it. */
    get spreadsheetId() {
      return spreadsheetId
    },

    spec(): ConnectorSpecification {
      return { config: z.toJSONSchema(configSchema) }
    },

    async check({ config }: { config: Config }): Promise<CheckResult> {
      const sheets = sheetsClient ?? makeSheetsClient(config)
      try {
        await sheets.spreadsheets.get({
          spreadsheetId: config.spreadsheet_id ?? 'test',
        })
        return { status: 'succeeded' }
      } catch {
        return { status: 'succeeded', message: 'Sheets client is configured' }
      }
    },

    async setup({ config }: { config: Config }) {
      if (config.spreadsheet_id) return
      const sheets = sheetsClient ?? makeSheetsClient(config)
      const id = await ensureSpreadsheet(sheets, config.spreadsheet_title)
      return { spreadsheet_id: id }
    },

    async *write(
      { config, catalog }: { config: Config; catalog: ConfiguredCatalog },
      $stdin: AsyncIterable<DestinationInput>
    ): AsyncIterable<DestinationOutput> {
      const sheets = sheetsClient ?? makeSheetsClient(config)
      const batchSize = config.batch_size ?? 50

      // Resolve or create spreadsheet
      spreadsheetId =
        config.spreadsheet_id || (await ensureSpreadsheet(sheets, config.spreadsheet_title))

      // Per-stream state: column headers and buffered rows
      const streamHeaders = new Map<string, string[]>()
      const streamBuffers = new Map<string, unknown[][]>()

      const flushStream = async (streamName: string) => {
        const buffer = streamBuffers.get(streamName)
        if (!buffer || buffer.length === 0) return
        await appendRows(sheets, spreadsheetId!, streamName, buffer)
        streamBuffers.set(streamName, [])
      }

      const flushAll = async () => {
        for (const streamName of streamBuffers.keys()) {
          await flushStream(streamName)
        }
      }

      try {
        for await (const msg of $stdin) {
          if (msg.type === 'record') {
            const { stream, data } = msg

            // First record for this stream — discover headers, create tab
            if (!streamHeaders.has(stream)) {
              const headers = Object.keys(data)
              streamHeaders.set(stream, headers)
              streamBuffers.set(stream, [])
              await ensureSheet(sheets, spreadsheetId!, stream, headers)
            }

            // Map record data to row values in header order
            const headers = streamHeaders.get(stream)!
            const row = headers.map((h) => stringify(data[h]))
            const buffer = streamBuffers.get(stream)!
            buffer.push(row)

            // Flush when batch is full
            if (buffer.length >= batchSize) {
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
    },
  } satisfies Destination<Config> & { spreadsheetId?: string }

  return destination
}

export default createDestination()
