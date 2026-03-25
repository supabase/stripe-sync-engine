import { describe, expect, it } from 'vitest'
import { createMemorySheets } from './memory-sheets.js'

describe('createMemorySheets', () => {
  it('create — returns an ID and a default Sheet1 tab', async () => {
    const { sheets } = createMemorySheets()

    const res = await sheets.spreadsheets.create({
      requestBody: { properties: { title: 'Test' } },
      fields: 'spreadsheetId',
    })

    expect(res.data.spreadsheetId).toBeTruthy()

    const meta = await sheets.spreadsheets.get({
      spreadsheetId: res.data.spreadsheetId!,
      fields: 'sheets.properties',
    })

    expect(meta.data.sheets).toHaveLength(1)
    expect(meta.data.sheets![0].properties?.title).toBe('Sheet1')
  })

  it('get — returns sheet metadata for all tabs', async () => {
    const { sheets } = createMemorySheets()

    const { data } = await sheets.spreadsheets.create({
      requestBody: { properties: { title: 'Multi' } },
    })
    const id = data.spreadsheetId!

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: { requests: [{ addSheet: { properties: { title: 'Extra' } } }] },
    })

    const meta = await sheets.spreadsheets.get({ spreadsheetId: id })
    const names = meta.data.sheets!.map((s) => s.properties?.title)
    expect(names).toEqual(['Sheet1', 'Extra'])
  })

  it('batchUpdate addSheet — adds a new tab', async () => {
    const { sheets, getData } = createMemorySheets()

    const { data } = await sheets.spreadsheets.create({
      requestBody: { properties: { title: 'T' } },
    })
    const id = data.spreadsheetId!

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: { requests: [{ addSheet: { properties: { title: 'customers' } } }] },
    })

    expect(getData(id, 'customers')).toEqual([])
  })

  it('batchUpdate addSheet — rejects duplicate tab names', async () => {
    const { sheets } = createMemorySheets()

    const { data } = await sheets.spreadsheets.create({
      requestBody: { properties: { title: 'T' } },
    })
    const id = data.spreadsheetId!

    await expect(
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: id,
        requestBody: { requests: [{ addSheet: { properties: { title: 'Sheet1' } } }] },
      })
    ).rejects.toThrow('Sheet already exists')
  })

  it('batchUpdate updateSheetProperties — renames a tab', async () => {
    const { sheets, getData } = createMemorySheets()

    const { data } = await sheets.spreadsheets.create({
      requestBody: { properties: { title: 'T' } },
    })
    const id = data.spreadsheetId!

    // Get the sheetId of the default Sheet1
    const meta = await sheets.spreadsheets.get({ spreadsheetId: id })
    const sheetId = meta.data.sheets![0].properties!.sheetId!

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: {
        requests: [
          { updateSheetProperties: { properties: { sheetId, title: 'orders' }, fields: 'title' } },
        ],
      },
    })

    expect(getData(id, 'Sheet1')).toBeUndefined()
    expect(getData(id, 'orders')).toEqual([])
  })

  it('values.update — writes at range (header row)', async () => {
    const { sheets, getData } = createMemorySheets()

    const { data } = await sheets.spreadsheets.create({
      requestBody: { properties: { title: 'T' } },
    })
    const id = data.spreadsheetId!

    await sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range: "'Sheet1'!A1",
      valueInputOption: 'RAW',
      requestBody: { values: [['id', 'name', 'email']] },
    })

    expect(getData(id, 'Sheet1')).toEqual([['id', 'name', 'email']])
  })

  it('values.append — appends rows after existing data', async () => {
    const { sheets, getData } = createMemorySheets()

    const { data } = await sheets.spreadsheets.create({
      requestBody: { properties: { title: 'T' } },
    })
    const id = data.spreadsheetId!

    // Write header
    await sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range: "'Sheet1'!A1",
      valueInputOption: 'RAW',
      requestBody: { values: [['id', 'name']] },
    })

    // Append two rows
    await sheets.spreadsheets.values.append({
      spreadsheetId: id,
      range: "'Sheet1'!A1",
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [
          ['1', 'Alice'],
          ['2', 'Bob'],
        ],
      },
    })

    expect(getData(id, 'Sheet1')).toEqual([
      ['id', 'name'],
      ['1', 'Alice'],
      ['2', 'Bob'],
    ])
  })

  it('values.get — reads back all values', async () => {
    const { sheets } = createMemorySheets()

    const { data } = await sheets.spreadsheets.create({
      requestBody: { properties: { title: 'T' } },
    })
    const id = data.spreadsheetId!

    await sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range: "'Sheet1'!A1",
      requestBody: { values: [['a', 'b']] },
    })
    await sheets.spreadsheets.values.append({
      spreadsheetId: id,
      range: "'Sheet1'!A1",
      requestBody: { values: [['1', '2']] },
    })

    const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: "'Sheet1'" })
    expect(res.data.values).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('get — throws on non-existent spreadsheet', async () => {
    const { sheets } = createMemorySheets()

    await expect(sheets.spreadsheets.get({ spreadsheetId: 'nope' })).rejects.toThrow(
      'Spreadsheet not found'
    )
  })

  it('values.append — throws on non-existent spreadsheet', async () => {
    const { sheets } = createMemorySheets()

    await expect(
      sheets.spreadsheets.values.append({
        spreadsheetId: 'nope',
        range: "'Sheet1'!A1",
        requestBody: { values: [['x']] },
      })
    ).rejects.toThrow('Spreadsheet not found')
  })
})
