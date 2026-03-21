import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  CatalogMessage,
  DestinationInput,
  DestinationOutput,
  RecordMessage,
  StateMessage,
} from '@stripe/protocol'
import { google } from 'googleapis'
import { describe, expect, it } from 'vitest'
import { createDestination, type Config, readSheet } from '../src/index'

// Credential paths — relative to monorepo root
const MONOREPO_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const CREDS_PATH = resolve(MONOREPO_ROOT, '.credentials/sheets/credentials.json')
const TOKEN_PATH = resolve(MONOREPO_ROOT, '.credentials/sheets/gog-refresh-token.json')

const credentialsExist = existsSync(CREDS_PATH) && existsSync(TOKEN_PATH)

function loadAuth() {
  const creds = JSON.parse(readFileSync(CREDS_PATH, 'utf-8'))
  const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'))

  const auth = new google.auth.OAuth2(creds.client_id, creds.client_secret)
  auth.setCredentials({ refresh_token: token.refresh_token })
  return auth
}

function loadSheetsClient() {
  return google.sheets({ version: 'v4', auth: loadAuth() })
}

/** Create an async iterator from an array of messages. */
async function* toAsyncIter<T>(items: T[]): AsyncIterableIterator<T> {
  for (const item of items) {
    yield item
  }
}

describe.skipIf(!credentialsExist)('destination-google-sheets E2E', () => {
  it('creates a spreadsheet, writes records, and verifies content', async () => {
    const sheets = loadSheetsClient()
    const dest = createDestination(sheets)

    const title = `sync-engine-test-${Date.now()}`

    // Build catalog
    const catalog: CatalogMessage = {
      type: 'catalog',
      streams: [
        {
          name: 'test_customers',
          primary_key: [['id']],
          json_schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              email: { type: 'string' },
              balance: { type: 'number' },
            },
          },
        },
      ],
    }

    // Build test messages
    const now = Date.now()
    const records: RecordMessage[] = [
      {
        type: 'record',
        stream: 'test_customers',
        data: { id: 'cus_1', name: 'Alice', email: 'alice@example.com', balance: 100 },
        emitted_at: now,
      },
      {
        type: 'record',
        stream: 'test_customers',
        data: { id: 'cus_2', name: 'Bob', email: 'bob@example.com', balance: 250 },
        emitted_at: now,
      },
      {
        type: 'record',
        stream: 'test_customers',
        data: { id: 'cus_3', name: 'Charlie', email: 'charlie@example.com', balance: 0 },
        emitted_at: now,
      },
      {
        type: 'record',
        stream: 'test_customers',
        data: { id: 'cus_4', name: 'Diana', email: 'diana@example.com', balance: 500 },
        emitted_at: now,
      },
      {
        type: 'record',
        stream: 'test_customers',
        data: { id: 'cus_5', name: 'Eve', email: 'eve@example.com', balance: 75 },
        emitted_at: now,
      },
    ]

    const stateMsg: StateMessage = {
      type: 'state',
      stream: 'test_customers',
      data: { cursor: 'cus_5' },
    }

    const messages: DestinationInput[] = [...records, stateMsg]

    const config = {
      client_id: '',
      client_secret: '',
      access_token: '',
      refresh_token: '',
      spreadsheet_id: '',
      spreadsheet_title: title,
      batch_size: 50,
    } satisfies Config

    // Run the destination
    const output: DestinationOutput[] = []
    for await (const msg of dest.write({ config, catalog }, toAsyncIter(messages))) {
      output.push(msg)
    }

    // Verify: output includes re-emitted state + log
    const states = output.filter((m) => m.type === 'state')
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({
      type: 'state',
      stream: 'test_customers',
      data: { cursor: 'cus_5' },
    })

    const logs = output.filter((m) => m.type === 'log')
    expect(logs.length).toBeGreaterThanOrEqual(1)

    // Verify: read the spreadsheet back
    const spreadsheetId = dest.spreadsheetId!
    expect(spreadsheetId).toBeTruthy()

    const rows = await readSheet(sheets, spreadsheetId, 'test_customers')

    // Header row + 5 data rows
    expect(rows).toHaveLength(6)
    expect(rows[0]).toEqual(['id', 'name', 'email', 'balance'])
    expect(rows[1]).toEqual(['cus_1', 'Alice', 'alice@example.com', '100'])
    expect(rows[5]).toEqual(['cus_5', 'Eve', 'eve@example.com', '75'])

    // Cleanup: best-effort delete via Drive API
    try {
      const drive = google.drive({ version: 'v3', auth: loadAuth() })
      await drive.files.delete({ fileId: spreadsheetId })
    } catch {
      // Drive API may not be enabled — spreadsheet will remain in the account
      console.warn(`Cleanup skipped: could not delete spreadsheet ${spreadsheetId}`)
    }
  }, 30_000) // generous timeout for API calls
})
