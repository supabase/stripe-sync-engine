import type { DestinationInput, DestinationOutput } from '@stripe/protocol'
import { describe, expect, it } from 'vitest'
import { createDestination, type Config } from './index'
import { readSheet } from './writer'
import { createMemorySheets } from '../__tests__/memory-sheets'

/** Collect all output from the destination's write() generator. */
async function collect(iter: AsyncIterable<DestinationOutput>): Promise<DestinationOutput[]> {
  const out: DestinationOutput[] = []
  for await (const msg of iter) out.push(msg)
  return out
}

/** Turn an array into an async iterable. */
async function* toAsyncIter<T>(items: T[]): AsyncIterableIterator<T> {
  for (const item of items) yield item
}

const now = Date.now()

function record(stream: string, data: Record<string, unknown>): DestinationInput {
  return { type: 'record', stream, data, emitted_at: now }
}

function state(stream: string, data: unknown): DestinationInput {
  return { type: 'state', stream, data }
}

const catalog = { streams: [] } as never

/** Minimal config for tests — credentials are unused since we inject a fake client. */
function cfg(overrides: Partial<Config> = {}): Config {
  return {
    client_id: '',
    client_secret: '',
    access_token: '',
    refresh_token: '',
    spreadsheet_id: '',
    spreadsheet_title: 'Test',
    batch_size: 50,
    ...overrides,
  }
}

describe('destination-google-sheets', () => {
  it('header discovery — first record keys become header row', async () => {
    const { sheets, getData } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [
      record('users', { id: 'u1', name: 'Alice', email: 'alice@test.invalid' }),
    ]

    await collect(dest.write({ config: cfg(), catalog }, toAsyncIter(messages)))

    const id = dest.spreadsheetId!
    const rows = getData(id, 'users')!
    expect(rows[0]).toEqual(['id', 'name', 'email'])
    expect(rows[1]).toEqual(['u1', 'Alice', 'alice@test.invalid'])
  })

  it('batching — flushes when batch_size is reached', async () => {
    const { sheets, getData } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [
      record('items', { id: '1' }),
      record('items', { id: '2' }),
      record('items', { id: '3' }),
      record('items', { id: '4' }),
      record('items', { id: '5' }),
    ]

    await collect(dest.write({ config: cfg({ batch_size: 3 }), catalog }, toAsyncIter(messages)))

    const id = dest.spreadsheetId!
    const rows = getData(id, 'items')!
    // header + 5 data rows (batch at 3, then remaining 2 flushed at end)
    expect(rows).toHaveLength(6)
    expect(rows[0]).toEqual(['id'])
    expect(rows[5]).toEqual(['5'])
  })

  it('state passthrough — flushes buffer then re-emits state', async () => {
    const { sheets, getData } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [
      record('orders', { id: 'o1', total: 42 }),
      record('orders', { id: 'o2', total: 99 }),
      state('orders', { cursor: 'o2' }),
      record('orders', { id: 'o3', total: 10 }),
    ]

    const output = await collect(
      dest.write({ config: cfg({ batch_size: 100 }), catalog }, toAsyncIter(messages))
    )

    // State should be re-emitted
    const states = output.filter((m) => m.type === 'state')
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({ type: 'state', stream: 'orders', data: { cursor: 'o2' } })

    // All 3 records should be written (2 flushed by state, 1 flushed at end)
    const id = dest.spreadsheetId!
    const rows = getData(id, 'orders')!
    expect(rows).toHaveLength(4) // header + 3 rows
  })

  it('multi-stream — two streams get independent tabs and headers', async () => {
    const { sheets, getData } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [
      record('customers', { id: 'c1', name: 'Alice' }),
      record('invoices', { id: 'inv_1', amount: 100, customer: 'c1' }),
      record('customers', { id: 'c2', name: 'Bob' }),
      record('invoices', { id: 'inv_2', amount: 200, customer: 'c2' }),
    ]

    await collect(dest.write({ config: cfg(), catalog }, toAsyncIter(messages)))

    const id = dest.spreadsheetId!

    const customerRows = getData(id, 'customers')!
    expect(customerRows[0]).toEqual(['id', 'name'])
    expect(customerRows).toHaveLength(3) // header + 2

    const invoiceRows = getData(id, 'invoices')!
    expect(invoiceRows[0]).toEqual(['id', 'amount', 'customer'])
    expect(invoiceRows).toHaveLength(3) // header + 2
  })

  it('spreadsheet creation — auto-creates when no spreadsheet_id given', async () => {
    const { sheets } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [record('data', { x: 1 })]

    await collect(
      dest.write({ config: cfg({ spreadsheet_id: '' }), catalog }, toAsyncIter(messages))
    )

    expect(dest.spreadsheetId).toBeTruthy()
    expect(dest.spreadsheetId).toMatch(/^mem_ss_/)
  })

  it('uses existing spreadsheet_id when provided', async () => {
    const { sheets } = createMemorySheets()

    // Pre-create a spreadsheet
    const res = await sheets.spreadsheets.create({
      requestBody: { properties: { title: 'Existing' } },
    })
    const existingId = res.data.spreadsheetId!

    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [record('data', { x: 1 })]
    await collect(
      dest.write({ config: cfg({ spreadsheet_id: existingId }), catalog }, toAsyncIter(messages))
    )

    expect(dest.spreadsheetId).toBe(existingId)
  })

  it('Sheet1 rename — first stream renames the default tab', async () => {
    const { sheets, getData } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [record('my_stream', { a: 1 })]

    await collect(dest.write({ config: cfg(), catalog }, toAsyncIter(messages)))

    const id = dest.spreadsheetId!
    // Default "Sheet1" should have been renamed to "my_stream"
    expect(getData(id, 'Sheet1')).toBeUndefined()
    expect(getData(id, 'my_stream')).toBeDefined()
  })

  it('end-of-stream flush — remaining buffered rows written when input ends', async () => {
    const { sheets, getData } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [
      record('events', { id: 'e1' }),
      record('events', { id: 'e2' }),
      // batch_size=100, so these won't trigger a mid-stream flush
    ]

    await collect(dest.write({ config: cfg({ batch_size: 100 }), catalog }, toAsyncIter(messages)))

    const id = dest.spreadsheetId!
    const rows = getData(id, 'events')!
    expect(rows).toHaveLength(3) // header + 2 rows
  })

  it('value stringification — null, numbers, booleans, objects', async () => {
    const { sheets, getData } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [
      record('types', {
        str: 'hello',
        num: 42,
        bool: true,
        nil: null,
        obj: { nested: true },
      }),
    ]

    await collect(dest.write({ config: cfg(), catalog }, toAsyncIter(messages)))

    const id = dest.spreadsheetId!
    const rows = getData(id, 'types')!
    expect(rows[1]).toEqual(['hello', '42', 'true', '', '{"nested":true}'])
  })

  it('readSheet helper — reads back data through the fake client', async () => {
    const { sheets } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [
      record('test', { a: '1', b: '2' }),
      record('test', { a: '3', b: '4' }),
    ]

    await collect(dest.write({ config: cfg(), catalog }, toAsyncIter(messages)))

    const rows = await readSheet(sheets, dest.spreadsheetId!, 'test')
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ])
  })

  it('final log message — always yields a log message at the end', async () => {
    const { sheets } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [record('x', { id: '1' })]

    const output = await collect(dest.write({ config: cfg(), catalog }, toAsyncIter(messages)))

    const logs = output.filter((m) => m.type === 'log')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ type: 'log', level: 'info' })
  })
})
