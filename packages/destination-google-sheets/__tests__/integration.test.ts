import type {
  ConfiguredCatalog,
  DestinationInput,
  DestinationOutput,
  RecordMessage,
  SourceStateMessage,
} from '@stripe/sync-protocol'
import { google } from 'googleapis'
import { expect, it } from 'vitest'
import { createDestination, type Config, readSheet } from '../src/index.js'
import { describeWithEnv } from '../../../e2e/test-helpers.js'

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

    function stripUpdatedAt(rows: unknown[][]): unknown[][] {
      const idx = rows[0]?.indexOf('_updated_at') ?? -1
      return idx < 0 ? rows : rows.map((row) => row.filter((_, i) => i !== idx))
    }

    it.skip('writes records to an existing spreadsheet and reads them back', async () => {
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
      const emittedAt = new Date().toISOString()

      const records: RecordMessage[] = [
        {
          type: 'record',
          record: {
            stream: streamName,
            data: { id: 'cus_1', name: 'Alice', balance: 100 },
            emitted_at: emittedAt,
          },
        },
        {
          type: 'record',
          record: {
            stream: streamName,
            data: { id: 'cus_2', name: 'Bob', balance: 250 },
            emitted_at: emittedAt,
          },
        },
        {
          type: 'record',
          record: {
            stream: streamName,
            data: { id: 'cus_3', name: 'Charlie', balance: 0 },
            emitted_at: emittedAt,
          },
        },
      ]

      const stateMsg: SourceStateMessage = {
        type: 'source_state',
        source_state: {
          stream: streamName,
          data: { cursor: 'cus_3' },
        },
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

      // State re-emitted (envelope format)
      const states = output.filter((m) => m.type === 'source_state')
      expect(states).toHaveLength(1)
      expect(states[0]).toMatchObject({
        type: 'source_state',
        source_state: { stream: streamName, data: { cursor: 'cus_3' } },
      })

      // No trace errors
      const traces = output.filter((m) => m.type === 'trace' && m.trace.trace_type === 'error')
      expect(traces).toHaveLength(0)

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

    it('native upsert — updates existing rows by primary key', async () => {
      const sheets = makeSheetsClient()
      const dest = createDestination(sheets)

      const iso = new Date().toISOString()
      const ts =
        iso.slice(0, 10).replace(/-/g, '') +
        '_' +
        iso.slice(11, 19).replace(/:/g, '') +
        '_' +
        iso.slice(20, 23)
      const streamName = `upsert_${ts}`
      const emittedAt = new Date().toISOString()
      let nextUpdatedAt = Math.floor(Date.now() / 1000)

      const config: Config = {
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        access_token: '',
        refresh_token: GOOGLE_REFRESH_TOKEN,
        spreadsheet_id: GOOGLE_SPREADSHEET_ID,
        spreadsheet_title: 'unused',
        batch_size: 50,
      }

      const catalog: ConfiguredCatalog = {
        streams: [
          {
            stream: {
              name: streamName,
              primary_key: [['id']],
              newer_than_field: '_updated_at',
              json_schema: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  balance: { type: 'number' },
                },
              },
            },
            sync_mode: 'full_refresh',
            destination_sync_mode: 'append_dedup',
          },
        ],
      }

      // First write: insert 3 records
      const initialRecords: DestinationInput[] = [
        {
          type: 'record',
          record: {
            stream: streamName,
            data: { id: 'cus_1', name: 'Alice', balance: 100, _updated_at: nextUpdatedAt++ },
            emitted_at: emittedAt,
          },
        },
        {
          type: 'record',
          record: {
            stream: streamName,
            data: { id: 'cus_2', name: 'Bob', balance: 250, _updated_at: nextUpdatedAt++ },
            emitted_at: emittedAt,
          },
        },
        {
          type: 'record',
          record: {
            stream: streamName,
            data: { id: 'cus_3', name: 'Charlie', balance: 0, _updated_at: nextUpdatedAt++ },
            emitted_at: emittedAt,
          },
        },
      ]

      const output1: DestinationOutput[] = []
      for await (const msg of dest.write({ config, catalog }, toAsyncIter(initialRecords))) {
        output1.push(msg)
      }
      expect(output1.filter((m) => m.type === 'trace')).toHaveLength(0)

      // Verify initial state
      let rows = stripUpdatedAt(await readSheet(sheets, GOOGLE_SPREADSHEET_ID, streamName))
      expect(rows).toHaveLength(4) // header + 3 rows
      expect(rows[0]).toEqual(['id', 'name', 'balance']) // PK-first ordering

      // Second write: update cus_1 and cus_3, add cus_4 — no _row_number provided
      const upsertRecords: DestinationInput[] = [
        {
          type: 'record',
          record: {
            stream: streamName,
            data: {
              id: 'cus_1',
              name: 'Alice Updated',
              balance: 150,
              _updated_at: nextUpdatedAt++,
            },
            emitted_at: emittedAt,
          },
        },
        {
          type: 'record',
          record: {
            stream: streamName,
            data: {
              id: 'cus_3',
              name: 'Charlie Updated',
              balance: 50,
              _updated_at: nextUpdatedAt++,
            },
            emitted_at: emittedAt,
          },
        },
        {
          type: 'record',
          record: {
            stream: streamName,
            data: { id: 'cus_4', name: 'Diana', balance: 300, _updated_at: nextUpdatedAt++ },
            emitted_at: emittedAt,
          },
        },
      ]

      const dest2 = createDestination(sheets)
      const output2: DestinationOutput[] = []
      for await (const msg of dest2.write({ config, catalog }, toAsyncIter(upsertRecords))) {
        output2.push(msg)
      }
      expect(output2.filter((m) => m.type === 'trace')).toHaveLength(0)

      // Verify upsert results
      rows = stripUpdatedAt(await readSheet(sheets, GOOGLE_SPREADSHEET_ID, streamName))
      expect(rows).toHaveLength(5) // header + 3 original + 1 new
      expect(rows[0]).toEqual(['id', 'name', 'balance'])
      expect(rows[1]).toEqual(['cus_1', 'Alice Updated', '150']) // updated in place
      expect(rows[2]).toEqual(['cus_2', 'Bob', '250']) // unchanged
      expect(rows[3]).toEqual(['cus_3', 'Charlie Updated', '50']) // updated in place
      expect(rows[4]).toEqual(['cus_4', 'Diana', '300']) // appended

      // Clean up test tab
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

      console.log(
        `\n  Upsert test spreadsheet: https://docs.google.com/spreadsheets/d/${GOOGLE_SPREADSHEET_ID}/`
      )
    }, 30_000)
  }
)
