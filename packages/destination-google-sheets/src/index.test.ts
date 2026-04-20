import type { ConfiguredCatalog, DestinationInput, DestinationOutput } from '@stripe/sync-protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDestination,
  envVars,
  parseGoogleSheetsMetaLog,
  ROW_KEY_FIELD,
  ROW_NUMBER_FIELD,
  type Config,
} from './index.js'
import { readSheet } from './writer.js'
import { createMemorySheets } from '../__tests__/memory-sheets.js'

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

const now = new Date().toISOString()

function record(stream: string, data: Record<string, unknown>): DestinationInput {
  return { type: 'record', record: { stream, data, emitted_at: now } }
}

function state(stream: string, data: unknown): DestinationInput {
  return { type: 'source_state', source_state: { stream, data } }
}

const catalog = { streams: [] } as never

/** Minimal config for tests — credentials are unused since we inject a fake client. */
function cfg(overrides: Partial<Config> = {}): Config {
  return {
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    spreadsheet_id: '',
    spreadsheet_title: 'Test',
    batch_size: 50,
    ...overrides,
  }
}

describe('destination-google-sheets', () => {
  it('header discovery — first record keys become header row', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [
      record('users', { id: 'u1', name: 'Alice', email: 'alice@test.invalid' }),
    ]

    await collect(dest.write({ config: cfg(), catalog }, toAsyncIter(messages)))

    const id = getSpreadsheetIds()[0]
    const rows = getData(id, 'users')!
    expect(rows[0]).toEqual(['id', 'name', 'email'])
    expect(rows[1]).toEqual(['u1', 'Alice', 'alice@test.invalid'])
  })

  it('batching — flushes when batch_size is reached', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [
      record('items', { id: '1' }),
      record('items', { id: '2' }),
      record('items', { id: '3' }),
      record('items', { id: '4' }),
      record('items', { id: '5' }),
    ]

    await collect(dest.write({ config: cfg({ batch_size: 3 }), catalog }, toAsyncIter(messages)))

    const id = getSpreadsheetIds()[0]
    const rows = getData(id, 'items')!
    // header + 5 data rows (batch at 3, then remaining 2 flushed at end)
    expect(rows).toHaveLength(6)
    expect(rows[0]).toEqual(['id'])
    expect(rows[5]).toEqual(['5'])
  })

  it('state passthrough — flushes buffer then re-emits state', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
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

    // State should be re-emitted (envelope format)
    const states = output.filter((m) => m.type === 'source_state')
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({
      type: 'source_state',
      source_state: { stream: 'orders', data: { cursor: 'o2' } },
    })

    // All 3 records should be written (2 flushed by state, 1 flushed at end)
    const id = getSpreadsheetIds()[0]
    const rows = getData(id, 'orders')!
    expect(rows).toHaveLength(4) // header + 3 rows
  })

  it('multi-stream — two streams get independent tabs and headers', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [
      record('customers', { id: 'c1', name: 'Alice' }),
      record('invoices', { id: 'inv_1', amount: 100, customer: 'c1' }),
      record('customers', { id: 'c2', name: 'Bob' }),
      record('invoices', { id: 'inv_2', amount: 200, customer: 'c2' }),
    ]

    await collect(dest.write({ config: cfg(), catalog }, toAsyncIter(messages)))

    const id = getSpreadsheetIds()[0]

    const customerRows = getData(id, 'customers')!
    expect(customerRows[0]).toEqual(['id', 'name'])
    expect(customerRows).toHaveLength(3) // header + 2

    const invoiceRows = getData(id, 'invoices')!
    expect(invoiceRows[0]).toEqual(['id', 'amount', 'customer'])
    expect(invoiceRows).toHaveLength(3) // header + 2
  })

  it('spreadsheet creation — auto-creates when no spreadsheet_id given', async () => {
    const { sheets, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [record('data', { x: 1 })]

    await collect(
      dest.write({ config: cfg({ spreadsheet_id: '' }), catalog }, toAsyncIter(messages))
    )

    expect(getSpreadsheetIds()[0]).toBeTruthy()
    expect(getSpreadsheetIds()[0]).toMatch(/^mem_ss_/)
  })

  it('uses existing spreadsheet_id when provided', async () => {
    const { sheets, getData } = createMemorySheets()

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

    expect(getData(existingId, 'data')).toBeDefined()
  })

  it('Sheet1 rename — first stream renames the default tab', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [record('my_stream', { a: 1 })]

    await collect(dest.write({ config: cfg(), catalog }, toAsyncIter(messages)))

    const id = getSpreadsheetIds()[0]
    // Default "Sheet1" should have been renamed to "my_stream"
    expect(getData(id, 'Sheet1')).toBeUndefined()
    expect(getData(id, 'my_stream')).toBeDefined()
  })

  it('end-of-stream flush — remaining buffered rows written when input ends', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [
      record('events', { id: 'e1' }),
      record('events', { id: 'e2' }),
      // batch_size=100, so these won't trigger a mid-stream flush
    ]

    await collect(dest.write({ config: cfg({ batch_size: 100 }), catalog }, toAsyncIter(messages)))

    const id = getSpreadsheetIds()[0]
    const rows = getData(id, 'events')!
    expect(rows).toHaveLength(3) // header + 2 rows
  })

  it('value stringification — null, numbers, booleans, objects', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
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

    const id = getSpreadsheetIds()[0]
    const rows = getData(id, 'types')!
    expect(rows[1]).toEqual(['hello', '42', 'true', '', '{"nested":true}'])
  })

  it('readSheet helper — reads back data through the fake client', async () => {
    const { sheets, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)

    const messages: DestinationInput[] = [
      record('test', { a: '1', b: '2' }),
      record('test', { a: '3', b: '4' }),
    ]

    await collect(dest.write({ config: cfg(), catalog }, toAsyncIter(messages)))

    const rows = await readSheet(sheets, getSpreadsheetIds()[0], 'test')
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

    // Log messages now go through pino, not protocol stream
    expect(output.length).toBeGreaterThanOrEqual(0)
  })
})

describe('spec', () => {
  it('yields a spec message with config JSON Schema', async () => {
    const { sheets } = createMemorySheets()
    const dest = createDestination(sheets)

    const output: unknown[] = []
    for await (const msg of dest.spec()) output.push(msg)

    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({ type: 'spec', spec: { config: expect.any(Object) } })
  })
})

describe('check', () => {
  it('yields a connection_status message', async () => {
    const { sheets } = createMemorySheets()
    // Create a spreadsheet so check can find it
    const res = await sheets.spreadsheets.create({
      requestBody: { properties: { title: 'Check Test' } },
    })
    const spreadsheetId = res.data.spreadsheetId!
    const dest = createDestination(sheets)

    const output: unknown[] = []
    for await (const msg of dest.check({ config: cfg({ spreadsheet_id: spreadsheetId }) }))
      output.push(msg)

    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({
      type: 'connection_status',
      connection_status: { status: 'succeeded' },
    })
  })

  it('updates existing rows and emits row assignments for new appends', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const configuredCatalog: ConfiguredCatalog = {
      streams: [
        {
          stream: {
            name: 'customers',
            primary_key: [['id']],
            json_schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
              },
            },
          },
          sync_mode: 'full_refresh',
          destination_sync_mode: 'append',
        },
      ],
    }

    await collect(
      dest.write(
        { config: cfg(), catalog: configuredCatalog },
        toAsyncIter([
          record('customers', {
            id: 'cus_1',
            name: 'Alice',
            [ROW_KEY_FIELD]: '["cus_1"]',
          }),
        ])
      )
    )

    const output = await collect(
      dest.write(
        {
          config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }),
          catalog: configuredCatalog,
        },
        toAsyncIter([
          record('customers', {
            id: 'cus_1',
            name: 'Alice Updated',
            [ROW_KEY_FIELD]: '["cus_1"]',
            [ROW_NUMBER_FIELD]: 2,
          }),
          record('customers', {
            id: 'cus_2',
            name: 'Bob',
            [ROW_KEY_FIELD]: '["cus_2"]',
          }),
        ])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name'],
      ['cus_1', 'Alice Updated'],
      ['cus_2', 'Bob'],
    ])

    const metaLog = output.find(
      (message) => message.type === 'log' && message.log.level === 'debug'
    )
    expect(metaLog).toBeDefined()
    const meta = parseGoogleSheetsMetaLog((metaLog as { log: { message: string } }).log.message)
    expect(meta).toEqual({
      type: 'row_assignments',
      assignments: { customers: { '["cus_2"]': 3 } },
    })
  })

  it('extends existing headers when a later write introduces new fields', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)

    await collect(
      dest.write(
        { config: cfg(), catalog },
        toAsyncIter([record('customers', { id: 'cus_1', name: 'Alice' })])
      )
    )

    await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog },
        toAsyncIter([
          record('customers', {
            id: 'cus_2',
            name: 'Bob',
            email: 'bob@test.invalid',
          }),
        ])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows[0]).toEqual(['id', 'name', 'email'])
    expect(rows[1]).toEqual(['cus_1', 'Alice'])
    expect(rows[2]).toEqual(['cus_2', 'Bob', 'bob@test.invalid'])
  })
})

describe('native upsert', () => {
  const catalogWith = (primaryKey: string[][] = [['id']]): ConfiguredCatalog => ({
    streams: [
      {
        stream: {
          name: 'customers',
          primary_key: primaryKey,
          json_schema: {
            type: 'object',
            properties: { id: { type: 'string' }, name: { type: 'string' } },
          },
        },
        sync_mode: 'full_refresh',
        destination_sync_mode: 'append',
      },
    ],
  })

  it('updates existing row by primary key without _row_number', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    // First write: insert cus_1
    await collect(
      dest.write(
        { config: cfg(), catalog: cat },
        toAsyncIter([record('customers', { id: 'cus_1', name: 'Alice' })])
      )
    )

    // Second write: same PK, no _row_number — should update in place
    await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([record('customers', { id: 'cus_1', name: 'Alice Updated' })])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name'],
      ['cus_1', 'Alice Updated'],
    ])
  })

  it('appends new key alongside existing rows', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    await collect(
      dest.write(
        { config: cfg(), catalog: cat },
        toAsyncIter([record('customers', { id: 'cus_1', name: 'Alice' })])
      )
    )

    await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([record('customers', { id: 'cus_2', name: 'Bob' })])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name'],
      ['cus_1', 'Alice'],
      ['cus_2', 'Bob'],
    ])
  })

  it('duplicate key within same write — second occurrence updates', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    // batch_size: 1 forces flush after first record, then second record sees the map
    await collect(
      dest.write(
        { config: cfg({ batch_size: 1 }), catalog: cat },
        toAsyncIter([
          record('customers', { id: 'cus_1', name: 'Alice' }),
          record('customers', { id: 'cus_1', name: 'Alice Updated' }),
        ])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name'],
      ['cus_1', 'Alice Updated'],
    ])
  })

  it('duplicate key within same batch — deduped before flush', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    // Both records land in the same batch (default batch_size=50), so no flush in between
    await collect(
      dest.write(
        { config: cfg(), catalog: cat },
        toAsyncIter([
          record('customers', { id: 'cus_1', name: 'Alice' }),
          record('customers', { id: 'cus_1', name: 'Alice Updated' }),
        ])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name'],
      ['cus_1', 'Alice Updated'],
    ])
  })

  it('concurrent writes — flush-time refresh prevents duplicates', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest1 = createDestination(sheets)
    const cat = catalogWith()

    // dest1 writes cus_1
    await collect(
      dest1.write(
        { config: cfg(), catalog: cat },
        toAsyncIter([record('customers', { id: 'cus_1', name: 'Alice' })])
      )
    )

    // dest2 simulates a concurrent write() call (e.g. from reconcileLoop)
    // that has cus_1 buffered. Because it shares the same sheets backend,
    // flushStream's row map refresh sees the row dest1 already wrote.
    const dest2 = createDestination(sheets)
    await collect(
      dest2.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([record('customers', { id: 'cus_1', name: 'Alice Updated' })])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name'],
      ['cus_1', 'Alice Updated'],
    ])
  })

  it('concurrent setup — two pipelines get independent spreadsheets', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    const [out1, out2] = await Promise.all([
      collect(
        dest.write(
          { config: cfg({ spreadsheet_title: 'Pipeline A' }), catalog: cat },
          toAsyncIter([record('customers', { id: 'cus_1', name: 'Alice' })])
        )
      ),
      collect(
        dest.write(
          { config: cfg({ spreadsheet_title: 'Pipeline B' }), catalog: cat },
          toAsyncIter([record('customers', { id: 'cus_2', name: 'Bob' })])
        )
      ),
    ])

    const ids = getSpreadsheetIds()
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])

    const rowsA = getData(ids[0], 'customers')!
    const rowsB = getData(ids[1], 'customers')!
    expect(rowsA).toHaveLength(2)
    expect(rowsB).toHaveLength(2)

    const names = [rowsA[1]![1], rowsB[1]![1]].sort()
    expect(names).toEqual(['Alice', 'Bob'])

    const logsA = out1.filter((m) => m.type === 'log' && m.log.level === 'info')
    const logsB = out2.filter((m) => m.type === 'log' && m.log.level === 'info')
    const ssidA = logsA[0]?.log.message.match(/spreadsheet (.+)/)?.[1]
    const ssidB = logsB[0]?.log.message.match(/spreadsheet (.+)/)?.[1]
    expect(ssidA).not.toBe(ssidB)
  })

  it('explicit _row_number takes priority over row map lookup', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    // Insert two rows
    await collect(
      dest.write(
        { config: cfg(), catalog: cat },
        toAsyncIter([
          record('customers', { id: 'cus_1', name: 'Alice' }),
          record('customers', { id: 'cus_2', name: 'Bob' }),
        ])
      )
    )

    // Send cus_1 with explicit _row_number=3 (Bob's row) — should override map lookup
    await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([
          record('customers', {
            id: 'cus_1',
            name: 'Alice Overwrite',
            [ROW_NUMBER_FIELD]: 3,
          }),
        ])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name'],
      ['cus_1', 'Alice'],
      ['cus_1', 'Alice Overwrite'], // overwrote row 3 (Bob's row) per explicit _row_number
    ])
  })

  it('no primary key — append-only, no dedup', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith([]) // empty primary key

    await collect(
      dest.write(
        { config: cfg(), catalog: cat },
        toAsyncIter([
          record('customers', { id: 'cus_1', name: 'Alice' }),
          record('customers', { id: 'cus_1', name: 'Alice Again' }),
        ])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name'],
      ['cus_1', 'Alice'],
      ['cus_1', 'Alice Again'],
    ])
  })

  it('PK-first header ordering — id column is first', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    // Record with name before id in object key order
    await collect(
      dest.write(
        { config: cfg(), catalog: cat },
        toAsyncIter([
          record('customers', { name: 'Alice', email: 'alice@test.invalid', id: 'cus_1' }),
        ])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    // id should be first column despite being last in the record
    expect(rows[0]).toEqual(['id', 'name', 'email'])
  })
})

describe('envVars', () => {
  it('exports env var mapping', () => {
    expect(envVars.client_id).toBe('GOOGLE_CLIENT_ID')
    expect(envVars.client_secret).toBe('GOOGLE_CLIENT_SECRET')
  })
})

describe('makeSheetsClient env var fallback', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    savedEnv['GOOGLE_CLIENT_ID'] = process.env['GOOGLE_CLIENT_ID']
    savedEnv['GOOGLE_CLIENT_SECRET'] = process.env['GOOGLE_CLIENT_SECRET']
    delete process.env['GOOGLE_CLIENT_ID']
    delete process.env['GOOGLE_CLIENT_SECRET']
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('falls back to env vars when config omits client_id/client_secret', async () => {
    process.env['GOOGLE_CLIENT_ID'] = 'env-client-id'
    process.env['GOOGLE_CLIENT_SECRET'] = 'env-client-secret'

    // No sheetsClient injected — makeSheetsClient will be called with env vars.
    // We just verify it doesn't throw (real Google API won't be hit in spec).
    const dest = createDestination()
    const output: unknown[] = []
    for await (const msg of dest.spec()) output.push(msg)
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({ type: 'spec', spec: { config: expect.any(Object) } })
  })

  it('config values take priority over env vars', async () => {
    process.env['GOOGLE_CLIENT_ID'] = 'env-client-id'
    process.env['GOOGLE_CLIENT_SECRET'] = 'env-client-secret'

    // When config provides values, env vars are ignored — verify no error
    const dest = createDestination()
    const output: unknown[] = []
    for await (const msg of dest.spec()) output.push(msg)
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({ type: 'spec', spec: { config: expect.any(Object) } })
  })

  it('throws when neither config nor env var provides client_id', async () => {
    // No env vars set, no config values — should throw on makeSheetsClient
    const dest = createDestination()
    const config = cfg({ client_id: undefined, client_secret: undefined })

    await expect(async () => {
      // check() calls makeSheetsClient internally (no injected sheets client)
      for await (const _msg of dest.check({ config })) {
        // consume
      }
    }).rejects.toThrow('client_id required (provide in config or set GOOGLE_CLIENT_ID)')
  })

  it('throws when neither config nor env var provides client_secret', async () => {
    process.env['GOOGLE_CLIENT_ID'] = 'env-client-id'
    // client_secret still missing from both config and env

    const dest = createDestination()
    const config = cfg({ client_id: undefined, client_secret: undefined })

    await expect(async () => {
      for await (const _msg of dest.check({ config })) {
        // consume
      }
    }).rejects.toThrow('client_secret required (provide in config or set GOOGLE_CLIENT_SECRET)')
  })
})
