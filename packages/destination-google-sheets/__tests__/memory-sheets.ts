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

  function parseStartRow(range: string): number {
    const match = range.match(/(\d+)/)
    return match ? Number(match[1]) : 1
  }

  function columnLabel(index: number): string {
    let value = index
    let label = ''
    while (value > 0) {
      const remainder = (value - 1) % 26
      label = String.fromCharCode(65 + remainder) + label
      value = Math.floor((value - 1) / 26)
    }
    return label || 'A'
  }

  // Slice `values` to an A1 range. `'Name'` → whole tab; `'Name'!A2:C[100]` → bounded.
  function sliceByRange(values: unknown[][], range: string): unknown[][] {
    const bang = range.indexOf('!')
    if (bang < 0) return values
    const m = range.slice(bang + 1).match(/^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/)
    if (!m) return values
    const colIdx = (s: string) =>
      [...s].reduce((v, ch) => v * 26 + (ch.charCodeAt(0) - 64), 0) - 1
    const startCol = colIdx(m[1])
    const startRow = m[2] ? Number(m[2]) - 1 : 0
    const endCol = m[3] !== undefined ? colIdx(m[3]) : Infinity
    const endRow = m[4] !== undefined ? Number(m[4]) - 1 : values.length - 1
    const out: unknown[][] = []
    for (let r = startRow; r <= Math.min(endRow, values.length - 1); r++) {
      const src = values[r] ?? []
      const slice: unknown[] = []
      for (let c = startCol; c <= Math.min(endCol, src.length - 1); c++) slice.push(src[c])
      out.push(slice)
    }
    return out
  }

  function getTab(spreadsheetId: string, range: string): SheetTab {
    const ss = getSpreadsheet(spreadsheetId)
    const name = parseSheetName(range)
    const tab = ss.sheets.get(name)
    if (!tab) throw Object.assign(new Error(`Sheet tab not found: ${name}`), { code: 400 })
    return tab
  }

  function getTabBySheetId(spreadsheetId: string, sheetId: number): SheetTab {
    const ss = getSpreadsheet(spreadsheetId)
    for (const tab of ss.sheets.values()) {
      if (tab.sheetId === sheetId) return tab
    }
    throw Object.assign(new Error(`Sheet not found: ${sheetId}`), { code: 400 })
  }

  function rowDataToValues(rowData: unknown): string[] {
    const values = (rowData as { values?: unknown[] })?.values ?? []
    return values.map((cell) => {
      const uev = (cell as { userEnteredValue?: { stringValue?: string } })?.userEnteredValue
      return uev?.stringValue ?? ''
    })
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
          properties: {
            sheetId: tab.sheetId,
            title: name,
            gridProperties: { rowCount: 1000, columnCount: 26 },
          },
        }))
        return { data: { sheets: sheetsMeta } }
      },

      async batchUpdate(params: { spreadsheetId: string; requestBody?: { requests?: unknown[] } }) {
        const ss = getSpreadsheet(params.spreadsheetId)
        const requests = (params.requestBody?.requests ?? []) as Record<string, unknown>[]

        const replies: unknown[] = []

        for (const req of requests) {
          if (req.addSheet) {
            const props = (req.addSheet as { properties?: { title?: string } }).properties
            const name = props?.title ?? `Sheet${ss.sheets.size + 1}`
            if (ss.sheets.has(name)) {
              throw Object.assign(new Error(`Sheet already exists: ${name}`), { code: 400 })
            }
            const sheetId = nextSheetId++
            ss.sheets.set(name, { sheetId, values: [] })
            replies.push({ addSheet: { properties: { sheetId, title: name } } })
          } else if (req.updateSheetProperties) {
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
            replies.push({})
          } else if (req.appendCells) {
            const ac = req.appendCells as { sheetId: number; rows?: unknown[] }
            const tab = getTabBySheetId(params.spreadsheetId, ac.sheetId)
            for (const row of ac.rows ?? []) tab.values.push(rowDataToValues(row))
            replies.push({})
          } else if (req.updateCells) {
            const uc = req.updateCells as {
              start?: { sheetId?: number; rowIndex?: number; columnIndex?: number }
              rows?: unknown[]
            }
            const sheetId = uc.start?.sheetId
            if (sheetId != null) {
              const tab = getTabBySheetId(params.spreadsheetId, sheetId)
              const rowIndex = uc.start?.rowIndex ?? 0
              const rows = (uc.rows ?? []).map(rowDataToValues)
              for (let i = 0; i < rows.length; i++) {
                tab.values[rowIndex + i] = rows[i]
              }
            }
            replies.push({})
          } else if (req.appendDimension) {
            // No-op in the fake: the backing arrays grow dynamically, so the
            // grid never actually constrains writes. Accept and reply empty
            // so production code paths that call appendDimension succeed.
            replies.push({})
          } else if (req.pasteData) {
            // Parse a pasteData request and write its cells into the tab. The
            // production code uses `\x1f` as column delimiter and `\n` as row
            // delimiter (fixed by the API), with `PASTE_VALUES` semantics.
            const pd = req.pasteData as {
              coordinate?: { sheetId?: number; rowIndex?: number; columnIndex?: number }
              data?: string
              delimiter?: string
              type?: string
            }
            const sheetId = pd.coordinate?.sheetId
            if (sheetId != null) {
              const tab = getTabBySheetId(params.spreadsheetId, sheetId)
              const rowIndex = pd.coordinate?.rowIndex ?? 0
              const columnIndex = pd.coordinate?.columnIndex ?? 0
              const delimiter = pd.delimiter ?? '\t'
              const raw = pd.data ?? ''
              const rowLines = raw.length === 0 ? [] : raw.split('\n')
              for (let i = 0; i < rowLines.length; i++) {
                const cells = rowLines[i].split(delimiter)
                const target: unknown[] = (tab.values[rowIndex + i] ?? []).slice()
                for (let j = 0; j < cells.length; j++) {
                  target[columnIndex + j] = cells[j]
                }
                tab.values[rowIndex + i] = target
              }
            }
            replies.push({})
          } else {
            replies.push({})
          }
        }

        return { data: { replies } }
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
          const startRow = parseStartRow(params.range)
          for (let i = 0; i < rows.length; i++) {
            tab.values[startRow - 1 + i] = rows[i]
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
          const startRow = tab.values.length + 1
          tab.values.push(...rows)
          const endRow = tab.values.length
          return {
            data: {
              updates: {
                updatedRange: `'${parseSheetName(params.range)}'!A${startRow}:${columnLabel(rows[0]?.length ?? 1)}${endRow}`,
              },
            },
          }
        },

        async batchUpdate(params: {
          spreadsheetId: string
          requestBody?: {
            valueInputOption?: string
            data?: { range: string; values?: unknown[][] }[]
          }
        }) {
          for (const entry of params.requestBody?.data ?? []) {
            const tab = getTab(params.spreadsheetId, entry.range)
            const rows = entry.values ?? []
            const startRow = parseStartRow(entry.range)
            for (let i = 0; i < rows.length; i++) {
              tab.values[startRow - 1 + i] = rows[i]
            }
          }
          return { data: {} }
        },

        async get(params: { spreadsheetId: string; range: string }) {
          const tab = getTab(params.spreadsheetId, params.range)
          return { data: { values: tab.values } }
        },

        async batchGet(params: { spreadsheetId: string; ranges?: string[] }) {
          const ranges = params.ranges ?? []
          const valueRanges = ranges.map((range) => {
            try {
              const tab = getTab(params.spreadsheetId, range)
              return { range, values: sliceByRange(tab.values, range) }
            } catch {
              return { range, values: [] }
            }
          })
          return { data: { valueRanges } }
        },
      },
    },
  } as unknown as sheets_v4.Sheets

  function getData(spreadsheetId: string, sheetName: string): unknown[][] | undefined {
    const ss = store.get(spreadsheetId)
    if (!ss) return undefined
    return ss.sheets.get(sheetName)?.values
  }

  function getSpreadsheetIds(): string[] {
    return Array.from(store.keys())
  }

  return { sheets, getData, getSpreadsheetIds }
}
