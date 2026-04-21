#!/usr/bin/env node
import { google } from 'googleapis'

function printHelp() {
  process.stdout.write(`Reset a Google spreadsheet to an empty state.

Required env:
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  GOOGLE_REFRESH_TOKEN
  GOOGLE_SPREADSHEET_ID

Behavior:
  - keeps exactly one tab
  - deletes all other tabs
  - removes warning-only protections
  - renames the remaining tab to Sheet1
  - clears all values from the remaining tab

Usage:
  node --import tsx packages/destination-google-sheets/src/bin/reset.ts
`)
}

function mustGetEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main() {
  if (process.argv[2] === '--help' || process.argv[2] === '-h') {
    printHelp()
    return
  }

  const clientId = mustGetEnv('GOOGLE_CLIENT_ID')
  const clientSecret = mustGetEnv('GOOGLE_CLIENT_SECRET')
  const refreshToken = mustGetEnv('GOOGLE_REFRESH_TOKEN')
  const spreadsheetId = mustGetEnv('GOOGLE_SPREADSHEET_ID')

  const auth = new google.auth.OAuth2(clientId, clientSecret)
  auth.setCredentials({ refresh_token: refreshToken })

  const sheets = google.sheets({ version: 'v4', auth })

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields:
      'properties.title,sheets(properties(sheetId,title,index),protectedRanges(protectedRangeId))',
  })

  const tabs = [...(meta.data.sheets ?? [])]
  if (tabs.length === 0) {
    throw new Error('Spreadsheet has no sheets')
  }

  tabs.sort((a, b) => (a.properties?.index ?? 0) - (b.properties?.index ?? 0))
  const keeper = tabs[0]
  const keeperId = keeper.properties?.sheetId
  if (keeperId == null) {
    throw new Error('Failed to determine sheetId for the retained tab')
  }

  const requests: Array<Record<string, unknown>> = []
  for (const tab of tabs.slice(1)) {
    const sheetId = tab.properties?.sheetId
    if (sheetId != null) {
      requests.push({ deleteSheet: { sheetId } })
    }
  }

  for (const tab of tabs) {
    for (const protectedRange of tab.protectedRanges ?? []) {
      const protectedRangeId = protectedRange.protectedRangeId
      if (protectedRangeId != null) {
        requests.push({ deleteProtectedRange: { protectedRangeId } })
      }
    }
  }

  requests.push({
    updateSheetProperties: {
      properties: {
        sheetId: keeperId,
        title: 'Sheet1',
        index: 0,
      },
      fields: 'title,index',
    },
  })

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    })
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: 'Sheet1',
  })

  process.stderr.write(
    `Reset spreadsheet ${spreadsheetId} (${meta.data.properties?.title ?? 'untitled'})\n`
  )
  process.stderr.write(`Kept tab: Sheet1 (${keeper.properties?.title ?? 'unknown'})\n`)
  process.stderr.write(`Deleted tabs: ${Math.max(0, tabs.length - 1)}\n`)
  process.stderr.write('Spreadsheet is now empty.\n')
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
