/**
 * In-memory Google Sheets fake for unit testing.
 *
 * Implements the 6 `sheets_v4.Sheets` methods used by `writer.ts` and
 * `sheets-destination.ts` — no network calls, no credentials needed.
 */
import type { sheets_v4 } from 'googleapis'

interface SheetTab {
  sheetId: number
  values: unknown[][]
}

interface Spreadsheet {
  title: string
  sheets: Map<string, SheetTab>
}

let nextSpreadsheetId = 1
let nextSheetId = 1

/**
 * Create an in-memory Sheets client that satisfies the subset of
 * `sheets_v4.Sheets` used by this destination.
 *
 * @returns `sheets` — the fake client (cast to `sheets_v4.Sheets`),
 *          `getData` — inspect the underlying grid for assertions.
 */
export function createMemorySheets() {
  const store = new Map<string, Spreadsheet>()

  function getSpreadsheet(spreadsheetId: string): Spreadsheet {
    const ss = store.get(spreadsheetId)
    if (!ss)
      throw Object.assign(new Error(`Spreadsheet not found: ${spreadsheetId}`), { code: 404 })
    return ss
  }

  function parseSheetName(range: string): string {
    // Handles: 'sheetName'!A1  or  'sheetName'
    const match = range.match(/^'([^']+)'/)
    if (match) return match[1]
    // Fallback: unquoted range like SheetName!A1
    const bang = range.indexOf('!')
    return bang >= 0 ? range.slice(0, bang) : range
  }

  function getTab(spreadsheetId: string, range: string): SheetTab {
    const ss = getSpreadsheet(spreadsheetId)
    const name = parseSheetName(range)
    const tab = ss.sheets.get(name)
    if (!tab) throw Object.assign(new Error(`Sheet tab not found: ${name}`), { code: 400 })
    return tab
  }

  const sheets = {
    spreadsheets: {
      async create(params: { requestBody?: { properties?: { title?: string } }; fields?: string }) {
        const title = params.requestBody?.properties?.title ?? 'Untitled'
        const id = `mem_ss_${nextSpreadsheetId++}`
        const defaultTab: SheetTab = { sheetId: nextSheetId++, values: [] }
        const ss: Spreadsheet = { title, sheets: new Map([['Sheet1', defaultTab]]) }
        store.set(id, ss)
        return { data: { spreadsheetId: id } }
      },

      async get(params: { spreadsheetId: string; fields?: string }) {
        const ss = getSpreadsheet(params.spreadsheetId)
        const sheetsMeta = Array.from(ss.sheets.entries()).map(([name, tab]) => ({
          properties: { sheetId: tab.sheetId, title: name },
        }))
        return { data: { sheets: sheetsMeta } }
      },

      async batchUpdate(params: { spreadsheetId: string; requestBody?: { requests?: unknown[] } }) {
        const ss = getSpreadsheet(params.spreadsheetId)
        const requests = (params.requestBody?.requests ?? []) as Record<string, unknown>[]

        for (const req of requests) {
          if (req.addSheet) {
            const props = (req.addSheet as { properties?: { title?: string } }).properties
            const name = props?.title ?? `Sheet${ss.sheets.size + 1}`
            if (ss.sheets.has(name)) {
              throw Object.assign(new Error(`Sheet already exists: ${name}`), { code: 400 })
            }
            ss.sheets.set(name, { sheetId: nextSheetId++, values: [] })
          }

          if (req.updateSheetProperties) {
            const update = req.updateSheetProperties as {
              properties: { sheetId: number; title: string }
              fields: string
            }
            const targetId = update.properties.sheetId
            for (const [oldName, tab] of ss.sheets.entries()) {
              if (tab.sheetId === targetId) {
                ss.sheets.delete(oldName)
                ss.sheets.set(update.properties.title, tab)
                break
              }
            }
          }
        }

        return { data: {} }
      },

      values: {
        async update(params: {
          spreadsheetId: string
          range: string
          valueInputOption?: string
          requestBody?: { values?: unknown[][] }
        }) {
          const tab = getTab(params.spreadsheetId, params.range)
          const rows = params.requestBody?.values ?? []
          // values.update at A1 replaces from the top
          for (let i = 0; i < rows.length; i++) {
            tab.values[i] = rows[i]
          }
          return { data: {} }
        },

        async append(params: {
          spreadsheetId: string
          range: string
          valueInputOption?: string
          insertDataOption?: string
          requestBody?: { values?: unknown[][] }
        }) {
          const tab = getTab(params.spreadsheetId, params.range)
          const rows = params.requestBody?.values ?? []
          tab.values.push(...rows)
          return { data: {} }
        },

        async get(params: { spreadsheetId: string; range: string }) {
          const tab = getTab(params.spreadsheetId, params.range)
          return { data: { values: tab.values } }
        },
      },
    },
  } as unknown as sheets_v4.Sheets

  function getData(spreadsheetId: string, sheetName: string): unknown[][] | undefined {
    const ss = store.get(spreadsheetId)
    if (!ss) return undefined
    return ss.sheets.get(sheetName)?.values
  }

  return { sheets, getData }
}
