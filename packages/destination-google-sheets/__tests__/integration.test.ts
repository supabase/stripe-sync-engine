import type {
  DestinationInput,
  DestinationOutput,
  RecordMessage,
  StateMessage,
} from '@tx-stripe/protocol'
import { google } from 'googleapis'
import { expect, it } from 'vitest'
import { createDestination, type Config, readSheet } from '../src/index'
import { describeWithEnv } from '../../tests/test-helpers'

async function* toAsyncIter<T>(items: T[]): AsyncIterableIterator<T> {
  for (const item of items) yield item
}

describeWithEnv(
  'destination-google-sheets integration',
  ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_SPREADSHEET_ID'],
  ({ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_SPREADSHEET_ID }) => {
    function makeSheetsClient() {
      const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
      auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN })
      return google.sheets({ version: 'v4', auth })
    }

    it('writes records to an existing spreadsheet and reads them back', async () => {
      const sheets = makeSheetsClient()
      const dest = createDestination(sheets)

      const iso = new Date().toISOString()
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
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        access_token: '',
        refresh_token: GOOGLE_REFRESH_TOKEN,
        spreadsheet_id: GOOGLE_SPREADSHEET_ID,
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
      const rows = await readSheet(sheets, GOOGLE_SPREADSHEET_ID, streamName)
      expect(rows[0]).toEqual(['id', 'name', 'balance'])
      expect(rows).toHaveLength(4) // header + 3 rows
      expect(rows[1]).toEqual(['cus_1', 'Alice', '100'])
      expect(rows[3]).toEqual(['cus_3', 'Charlie', '0'])

      const url = `https://docs.google.com/spreadsheets/d/${GOOGLE_SPREADSHEET_ID}/`

      // Clean up test tab unless KEEP_TEST_DATA is set
      if (!process.env.KEEP_TEST_DATA) {
        const meta = await sheets.spreadsheets.get({
          spreadsheetId: GOOGLE_SPREADSHEET_ID,
          fields: 'sheets.properties',
        })
        const tab = meta.data.sheets?.find((s) => s.properties?.title === streamName)
        if (tab?.properties?.sheetId != null) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: GOOGLE_SPREADSHEET_ID,
            requestBody: {
              requests: [{ deleteSheet: { sheetId: tab.properties.sheetId } }],
            },
          })
        }
      }

      console.log(`\n  Spreadsheet: ${url}`)
    }, 30_000)
  }
)
