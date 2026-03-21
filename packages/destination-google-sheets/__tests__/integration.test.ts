import type {
  DestinationInput,
  DestinationOutput,
  RecordMessage,
  StateMessage,
} from '@stripe/protocol'
import { google } from 'googleapis'
import { describe, expect, it } from 'vitest'
import { createDestination, type Config, readSheet } from '../src/index'

const env = {
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
}

const hasEnv = !!(env.clientId && env.clientSecret && env.refreshToken && env.spreadsheetId)

function makeSheetsClient() {
  const auth = new google.auth.OAuth2(env.clientId, env.clientSecret)
  auth.setCredentials({ refresh_token: env.refreshToken })
  return google.sheets({ version: 'v4', auth })
}

async function* toAsyncIter<T>(items: T[]): AsyncIterableIterator<T> {
  for (const item of items) yield item
}

describe.skipIf(!hasEnv)('destination-google-sheets integration', () => {
  it('writes records to an existing spreadsheet and reads them back', async () => {
    const sheets = makeSheetsClient()
    const dest = createDestination(sheets)

    const iso = new Date().toISOString() // 2026-03-21T06:20:09.552Z
    const ts =
      iso.slice(0, 10).replace(/-/g, '') +
      '_' +
      iso.slice(11, 19).replace(/:/g, '') +
      '_' +
      iso.slice(20, 23)
    const streamName = `test_${ts}`
    const now = Date.now()

    const records: RecordMessage[] = [
      {
        type: 'record',
        stream: streamName,
        data: { id: 'cus_1', name: 'Alice', balance: 100 },
        emitted_at: now,
      },
      {
        type: 'record',
        stream: streamName,
        data: { id: 'cus_2', name: 'Bob', balance: 250 },
        emitted_at: now,
      },
      {
        type: 'record',
        stream: streamName,
        data: { id: 'cus_3', name: 'Charlie', balance: 0 },
        emitted_at: now,
      },
    ]

    const stateMsg: StateMessage = {
      type: 'state',
      stream: streamName,
      data: { cursor: 'cus_3' },
    }

    const messages: DestinationInput[] = [...records, stateMsg]

    const config: Config = {
      client_id: env.clientId!,
      client_secret: env.clientSecret!,
      access_token: '',
      refresh_token: env.refreshToken!,
      spreadsheet_id: env.spreadsheetId!,
      spreadsheet_title: 'unused',
      batch_size: 50,
    }

    const output: DestinationOutput[] = []
    for await (const msg of dest.write(
      { config, catalog: { streams: [] } },
      toAsyncIter(messages)
    )) {
      output.push(msg)
    }

    // State re-emitted
    const states = output.filter((m) => m.type === 'state')
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({
      type: 'state',
      stream: streamName,
      data: { cursor: 'cus_3' },
    })

    // No errors
    const errors = output.filter((m) => m.type === 'error')
    expect(errors).toHaveLength(0)

    // Log emitted
    const logs = output.filter((m) => m.type === 'log')
    expect(logs).toHaveLength(1)

    // Read back from the sheet
    const rows = await readSheet(sheets, env.spreadsheetId!, streamName)
    expect(rows[0]).toEqual(['id', 'name', 'balance'])
    expect(rows).toHaveLength(4) // header + 3 rows
    expect(rows[1]).toEqual(['cus_1', 'Alice', '100'])
    expect(rows[3]).toEqual(['cus_3', 'Charlie', '0'])

    const url = `https://docs.google.com/spreadsheets/d/${env.spreadsheetId}/`

    // Clean up test tab unless KEEP_TEST_DATA is set
    if (!process.env.KEEP_TEST_DATA) {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: env.spreadsheetId!,
        fields: 'sheets.properties',
      })
      const tab = meta.data.sheets?.find((s) => s.properties?.title === streamName)
      if (tab?.properties?.sheetId != null) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: env.spreadsheetId!,
          requestBody: {
            requests: [{ deleteSheet: { sheetId: tab.properties.sheetId } }],
          },
        })
      }
    }

    console.log(`\n  Spreadsheet: ${url}`)
  }, 30_000)
})
