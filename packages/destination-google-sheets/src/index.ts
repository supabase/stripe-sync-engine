import { z } from 'zod'
import { google } from 'googleapis'
import type { Destination } from '@stripe/protocol'
import { SheetsDestination } from './sheets-destination'

export { SheetsDestination, type SheetsDestinationConfig } from './sheets-destination'
export { ensureSpreadsheet, ensureSheet, appendRows, readSheet } from './writer'

// MARK: - Spec

export const spec = z.object({
  client_id: z.string().describe('Google OAuth2 client ID'),
  client_secret: z.string().describe('Google OAuth2 client secret'),
  access_token: z.string().describe('OAuth2 access token'),
  refresh_token: z.string().describe('OAuth2 refresh token'),
  spreadsheet_id: z.string().describe('Target spreadsheet ID'),
  spreadsheet_title: z
    .string()
    .default('Stripe Sync')
    .describe('Title when creating a new spreadsheet'),
  batch_size: z.number().default(50).describe('Rows per Sheets API append call'),
})

export type Config = z.infer<typeof spec>

// MARK: - Helpers

function makeSheetsClient(config: Config) {
  const auth = new google.auth.OAuth2(config.client_id, config.client_secret)
  auth.setCredentials({
    access_token: config.access_token,
    refresh_token: config.refresh_token,
  })
  return google.sheets({ version: 'v4', auth })
}

// MARK: - Destination

const destination = {
  spec() {
    return { config: z.toJSONSchema(spec) }
  },

  async check({ config }) {
    const sheets = makeSheetsClient(config)
    const dest = new SheetsDestination(
      {
        spreadsheet_title: config.spreadsheet_title,
        spreadsheet_id: config.spreadsheet_id,
        batch_size: config.batch_size,
      },
      sheets
    )
    return dest.check({ config })
  },

  async *write({ config, catalog }, $stdin) {
    const sheets = makeSheetsClient(config)
    const dest = new SheetsDestination(
      {
        spreadsheet_title: config.spreadsheet_title,
        spreadsheet_id: config.spreadsheet_id,
        batch_size: config.batch_size,
      },
      sheets
    )
    yield* dest.write({ config, catalog }, $stdin)
  },
} satisfies Destination<Config>

export default destination
