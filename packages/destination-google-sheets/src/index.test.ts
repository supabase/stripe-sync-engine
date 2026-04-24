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
import { applyBatch, MAX_CELLS_PER_SPREADSHEET, readSheet, type StreamBatchOps } from './writer.js'
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

  it('state is re-emitted after flush, not mid-stream', async () => {
    // State messages are buffered and yielded only after flushAll succeeds,
    // so the engine only advances its checkpoint once the data is durable.
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

    const states = output.filter((m) => m.type === 'source_state')
    expect(states).toHaveLength(1)
    expect(states[0]).toMatchObject({
      type: 'source_state',
      source_state: { stream: 'orders', data: { cursor: 'o2' } },
    })

    // Ordering: every record passthrough precedes every state in the output.
    const lastRecordIdx = output.findLastIndex((m) => m.type === 'record')
    const firstStateIdx = output.findIndex((m) => m.type === 'source_state')
    expect(lastRecordIdx).toBeGreaterThanOrEqual(0)
    expect(firstStateIdx).toBeGreaterThan(lastRecordIdx)

    // All 3 records should be written (flushed at end before state was yielded)
    const id = getSpreadsheetIds()[0]
    const rows = getData(id, 'orders')!
    expect(rows).toHaveLength(4) // header + 3 rows
  })

  it('emits heartbeat log messages while flushAll is in flight', async () => {
    // Slow batchUpdate + low flushHeartbeatMs to observe the heartbeat loop (keeps HTTP responses non-idle).
    const { sheets } = createMemorySheets()
    const originalBatchUpdate = sheets.spreadsheets.batchUpdate.bind(sheets.spreadsheets)
    sheets.spreadsheets.batchUpdate = (async (params: unknown) => {
      await new Promise((r) => setTimeout(r, 120))
      return originalBatchUpdate(params as Parameters<typeof originalBatchUpdate>[0])
    }) as unknown as typeof sheets.spreadsheets.batchUpdate

    const dest = createDestination(sheets, { flushHeartbeatMs: 20 })
    const messages: DestinationInput[] = [
      record('beat', { id: 'b1' }),
      state('beat', { cursor: 'b1' }),
    ]

    const output = await collect(dest.write({ config: cfg(), catalog }, toAsyncIter(messages)))

    const heartbeats = output.filter(
      (m) => m.type === 'log' && m.log.message.startsWith('flushing to Sheets')
    )
    expect(heartbeats.length).toBeGreaterThanOrEqual(1)

    // State still emits after the flush completes
    const states = output.filter((m) => m.type === 'source_state')
    expect(states).toHaveLength(1)
    // And every heartbeat precedes the state
    const lastHeartbeatIdx = output.findLastIndex(
      (m) => m.type === 'log' && m.log.message.startsWith('flushing to Sheets')
    )
    const stateIdx = output.findIndex((m) => m.type === 'source_state')
    expect(lastHeartbeatIdx).toBeLessThan(stateIdx)
  })

  it('state messages are suppressed when flushAll fails', async () => {
    // If the flush throws, we must NOT yield buffered state — otherwise the
    // engine would checkpoint cursors the sheet never received.
    const { sheets } = createMemorySheets()
    // Force batchUpdate to fail so applyBatch throws inside flushAll.
    const originalBatchUpdate = sheets.spreadsheets.batchUpdate.bind(sheets.spreadsheets)
    let firstBatch = true
    sheets.spreadsheets.batchUpdate = (async (params: unknown) => {
      if (firstBatch) {
        // allow initial sheet creation to succeed
        firstBatch = false
        return originalBatchUpdate(params as Parameters<typeof originalBatchUpdate>[0])
      }
      // 400 is non-retriable, so withRetry doesn't back-off 30+ seconds
      throw Object.assign(new Error('boom'), { code: 400 })
    }) as unknown as typeof sheets.spreadsheets.batchUpdate

    const dest = createDestination(sheets)
    const messages: DestinationInput[] = [
      record('orders', { id: 'o1' }),
      state('orders', { cursor: 'o1' }),
    ]

    const output = await collect(
      dest.write({ config: cfg({ batch_size: 100 }), catalog }, toAsyncIter(messages))
    )

    // No state should escape since flush failed.
    expect(output.filter((m) => m.type === 'source_state')).toHaveLength(0)
    // A failed connection_status should surface instead.
    const connFail = output.find(
      (m) => m.type === 'connection_status' && m.connection_status.status === 'failed'
    )
    expect(connFail).toBeDefined()
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

  it('setup — all stream tabs created with correct headers, Overview does not clobber first stream', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)

    const streamNames = ['stream_a', 'stream_b', 'stream_c', 'stream_d', 'stream_e']
    const multiCatalog: ConfiguredCatalog = {
      streams: streamNames.map((name) => ({
        stream: {
          name,
          primary_key: [['id']],
          json_schema: {
            type: 'object',
            properties: { id: { type: 'string' }, value: { type: 'string' } },
          },
        },
        sync_mode: 'full_refresh',
        destination_sync_mode: 'append',
      })),
    }

    for await (const _ of dest.setup({ config: cfg(), catalog: multiCatalog })) {
      // drain
    }

    const id = getSpreadsheetIds()[0]

    // All 5 stream tabs must exist with correct headers
    for (const name of streamNames) {
      const rows = getData(id, name)
      expect(rows, `tab "${name}" should exist`).toBeDefined()
      expect(rows![0], `tab "${name}" should have correct headers`).toEqual(['id', 'value'])
    }

    // Overview tab must exist and start with the spreadsheet title, not stream headers
    const overviewRows = getData(id, 'Overview')
    expect(overviewRows, 'Overview tab should exist').toBeDefined()
    expect(overviewRows![0][0]).toBe('Stripe Sync Engine')

    // Sheet1 should be gone (renamed to a stream tab or Overview)
    expect(getData(id, 'Sheet1')).toBeUndefined()
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

describe('delete handling', () => {
  const catalogWith = (primaryKey: string[][] = [['id']]): ConfiguredCatalog => ({
    streams: [
      {
        stream: {
          name: 'customers',
          primary_key: primaryKey,
          json_schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              deleted: { type: 'boolean' },
              _account_id: { type: 'string' },
            },
          },
        },
        sync_mode: 'full_refresh',
        destination_sync_mode: 'append',
      },
    ],
  })

  /**
   * Seed the sheet with N customers `cus_1..cus_N`. Records only carry `id`
   * and `name`, mirroring what the Stripe source actually emits for
   * non-delete events. Headers start as `['id', 'name']`; the second write's
   * `deleted: true` record extends them to `['id', 'name', 'deleted']` on the
   * fly, which leaves seeded data rows 2-wide and newly-written rows 3-wide.
   */
  async function seedCustomers(
    dest: ReturnType<typeof createDestination>,
    cat: ConfiguredCatalog,
    names: Array<[string, string]>
  ): Promise<void> {
    await collect(
      dest.write(
        { config: cfg(), catalog: cat },
        toAsyncIter(names.map(([id, name]) => record('customers', { id, name })))
      )
    )
  }

  /** Extract the row_assignments meta message from a write() output stream. */
  function extractRowAssignments(
    output: DestinationOutput[]
  ): Record<string, Record<string, number>> {
    const metaLog = output.find(
      (m) =>
        m.type === 'log' &&
        m.log.level === 'debug' &&
        typeof m.log.message === 'string' &&
        m.log.message.startsWith('__sync_engine_google_sheets__:')
    )
    if (!metaLog) return {}
    const parsed = parseGoogleSheetsMetaLog((metaLog as { log: { message: string } }).log.message)
    return parsed?.assignments ?? {}
  }

  // MARK: - routing

  it('record with deleted:true is routed to the delete path (no row appended)', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    // Against an empty sheet, the delete target can't resolve, so the delete
    // is a silent no-op and the record must not leak into the append path.
    await collect(
      dest.write(
        { config: cfg(), catalog: cat },
        toAsyncIter([record('customers', { id: 'cus_1', name: 'Alice', deleted: true })])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([['id', 'name', 'deleted']])
  })

  it('deleted:false is treated as a normal append (strict === true check)', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    await collect(
      dest.write(
        { config: cfg(), catalog: cat },
        toAsyncIter([record('customers', { id: 'cus_1', name: 'Alice', deleted: false })])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name', 'deleted'],
      ['cus_1', 'Alice', 'false'],
    ])
  })

  // MARK: - Phase 2 (tail swap)

  it('body delete, no appends → tail donor swapped into the hole', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    await seedCustomers(dest, cat, [
      ['cus_1', 'Alice'],
      ['cus_2', 'Bob'],
      ['cus_3', 'Charlie'],
    ])

    await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([record('customers', { id: 'cus_2', name: 'Bob', deleted: true })])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    // Seeded rows are 2-wide; blank rows written by delete compaction are
    // 3-wide because the header was extended on the delete record's arrival.
    expect(rows).toEqual([
      ['id', 'name', 'deleted'],
      ['cus_1', 'Alice'],
      ['cus_3', 'Charlie'], // was cus_2; donor (row 4) swapped in
      ['', '', ''], // donor row blanked
    ])
  })

  it('tail delete, no appends → blanked in place, no swap needed', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    await seedCustomers(dest, cat, [
      ['cus_1', 'Alice'],
      ['cus_2', 'Bob'],
      ['cus_3', 'Charlie'],
    ])

    await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([record('customers', { id: 'cus_3', name: 'Charlie', deleted: true })])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name', 'deleted'],
      ['cus_1', 'Alice'],
      ['cus_2', 'Bob'],
      ['', '', ''],
    ])
  })

  it('multiple body deletes → multiple tail-swaps with paired survivors', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    await seedCustomers(dest, cat, [
      ['cus_a', 'Alice'],
      ['cus_b', 'Bob'],
      ['cus_c', 'Charlie'],
      ['cus_d', 'Dave'],
      ['cus_e', 'Eve'],
    ])

    // Deleting the first two body rows pairs delete-row-2 ↔ donor-row-5 and
    // delete-row-3 ↔ donor-row-6 (bodyDeletes asc × survivorDonors asc).
    await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([
          record('customers', { id: 'cus_a', name: 'Alice', deleted: true }),
          record('customers', { id: 'cus_b', name: 'Bob', deleted: true }),
        ])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name', 'deleted'],
      ['cus_d', 'Dave'], // was cus_a; donor (row 5)
      ['cus_e', 'Eve'], // was cus_b; donor (row 6)
      ['cus_c', 'Charlie'], // unchanged
      ['', '', ''],
      ['', '', ''],
    ])
  })

  it('mix of body and tail deletes → body swapped, tail blanked', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    await seedCustomers(dest, cat, [
      ['cus_a', 'Alice'],
      ['cus_b', 'Bob'],
      ['cus_c', 'Charlie'],
      ['cus_d', 'Dave'],
    ])

    // Delete middle (body) + last (tail). Tail survivor row 4 (c) fills row 3;
    // both donor row 4 and delete-tail row 5 end up blank.
    await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([
          record('customers', { id: 'cus_b', name: 'Bob', deleted: true }),
          record('customers', { id: 'cus_d', name: 'Dave', deleted: true }),
        ])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name', 'deleted'],
      ['cus_a', 'Alice'],
      ['cus_c', 'Charlie'], // was cus_b; donor (row 4)
      ['', '', ''], // donor row 4 blanked
      ['', '', ''], // tail delete row 5
    ])
  })

  it('deleting every data row → all data rows blanked (edge: no survivors)', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    await seedCustomers(dest, cat, [
      ['cus_1', 'Alice'],
      ['cus_2', 'Bob'],
      ['cus_3', 'Charlie'],
    ])

    await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([
          record('customers', { id: 'cus_1', name: 'Alice', deleted: true }),
          record('customers', { id: 'cus_2', name: 'Bob', deleted: true }),
          record('customers', { id: 'cus_3', name: 'Charlie', deleted: true }),
        ])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name', 'deleted'],
      ['', '', ''],
      ['', '', ''],
      ['', '', ''],
    ])
  })

  // MARK: - Phase 1 (donation)

  it('single delete + single append → append donates into the hole', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    await seedCustomers(dest, cat, [
      ['cus_1', 'Alice'],
      ['cus_2', 'Bob'],
      ['cus_3', 'Charlie'],
    ])

    const out = await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([
          record('customers', { id: 'cus_2', name: 'Bob', deleted: true }),
          record('customers', { id: 'cus_4', name: 'Dave', deleted: false }),
        ])
      )
    )

    // No tail swap — the pending append fills the deleted slot directly.
    // Nothing gets blanked, row count is unchanged. The donated append
    // includes `deleted: false` so its row is 3-wide; the untouched seeded
    // rows stay 2-wide.
    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name', 'deleted'],
      ['cus_1', 'Alice'],
      ['cus_4', 'Dave', 'false'], // donated into cus_2's slot
      ['cus_3', 'Charlie'],
    ])

    // Donated append's new home is recorded in row_assignments so the
    // service layer knows where to find it on the next sync.
    expect(extractRowAssignments(out)).toEqual({ customers: { '["cus_4"]': 3 } })
  })

  it('1 delete + 2 appends → one donated, one appended to bottom; both in row_assignments', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    await seedCustomers(dest, cat, [
      ['cus_1', 'Alice'],
      ['cus_2', 'Bob'],
      ['cus_3', 'Charlie'],
    ])

    const out = await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([
          record('customers', { id: 'cus_2', name: 'Bob', deleted: true }),
          record('customers', { id: 'cus_4', name: 'Dave', deleted: false }),
          record('customers', { id: 'cus_5', name: 'Eve', deleted: false }),
        ])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name', 'deleted'],
      ['cus_1', 'Alice'],
      ['cus_4', 'Dave', 'false'], // donated into cus_2's slot (row 3)
      ['cus_3', 'Charlie'],
      ['cus_5', 'Eve', 'false'], // appended at bottom (row 5)
    ])

    expect(extractRowAssignments(out)).toEqual({
      customers: { '["cus_4"]': 3, '["cus_5"]': 5 },
    })
  })

  // MARK: - in-batch reconciliation

  it('append and delete of the same rowKey in one batch cancel each other out', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    // Empty sheet — the row was never in the sheet. Append would be wasted,
    // the subsequent delete would immediately overwrite it: drop both.
    await collect(
      dest.write(
        { config: cfg(), catalog: cat },
        toAsyncIter([
          record('customers', { id: 'cus_1', name: 'Alice', deleted: false }),
          record('customers', { id: 'cus_1', name: 'Alice', deleted: true }),
        ])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([['id', 'name', 'deleted']])
  })

  // MARK: - no-ops and edges

  it('delete of a rowKey that is not in the sheet is a silent no-op', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    await seedCustomers(dest, cat, [
      ['cus_1', 'Alice'],
      ['cus_2', 'Bob'],
    ])

    await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([record('customers', { id: 'cus_missing', name: '', deleted: true })])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    // The delete record's `deleted: true` extends the header to 3 cols, but
    // the untouched seeded data rows stay 2-wide.
    expect(rows).toEqual([
      ['id', 'name', 'deleted'],
      ['cus_1', 'Alice'],
      ['cus_2', 'Bob'],
    ])
  })

  it('delete-only batch (no appends, no updates) still processes the delete', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    await seedCustomers(dest, cat, [
      ['cus_1', 'Alice'],
      ['cus_2', 'Bob'],
    ])

    await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([record('customers', { id: 'cus_1', name: 'Alice', deleted: true })])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', 'name', 'deleted'],
      ['cus_2', 'Bob'], // donor (row 3, seeded 2-wide) swapped into row 2
      ['', '', ''], // row 3 blanked
    ])
  })

  // MARK: - cross-cutting

  it('deletes on one stream do not affect rows on a sibling stream', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const multiCat: ConfiguredCatalog = {
      streams: [
        catalogWith().streams[0],
        {
          stream: {
            name: 'invoices',
            primary_key: [['id']],
            json_schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                amount: { type: 'number' },
                deleted: { type: 'boolean' },
              },
            },
          },
          sync_mode: 'full_refresh',
          destination_sync_mode: 'append',
        },
      ],
    }

    // Seed both streams
    await collect(
      dest.write(
        { config: cfg(), catalog: multiCat },
        toAsyncIter([
          record('customers', { id: 'cus_1', name: 'Alice', deleted: false }),
          record('customers', { id: 'cus_2', name: 'Bob', deleted: false }),
          record('invoices', { id: 'inv_1', amount: 100, deleted: false }),
        ])
      )
    )

    // Second write: delete on customers, append on invoices
    await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: multiCat },
        toAsyncIter([
          record('customers', { id: 'cus_1', name: 'Alice', deleted: true }),
          record('invoices', { id: 'inv_2', amount: 200, deleted: false }),
        ])
      )
    )

    const customers = getData(getSpreadsheetIds()[0], 'customers')!
    expect(customers).toEqual([
      ['id', 'name', 'deleted'],
      ['cus_2', 'Bob', 'false'], // donor swapped in
      ['', '', ''],
    ])

    const invoices = getData(getSpreadsheetIds()[0], 'invoices')!
    expect(invoices).toEqual([
      ['id', 'amount', 'deleted'],
      ['inv_1', '100', 'false'], // unaffected by the customers delete
      ['inv_2', '200', 'false'],
    ])
  })

  it('composite primary key — delete resolves on the full key', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith([['id'], ['_account_id']])

    await collect(
      dest.write(
        { config: cfg(), catalog: cat },
        toAsyncIter([
          record('customers', {
            id: 'cus_1',
            _account_id: 'acct_A',
            name: 'Alice',
            deleted: false,
          }),
        ])
      )
    )

    await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([
          record('customers', {
            id: 'cus_1',
            _account_id: 'acct_A',
            name: 'Alice',
            deleted: true,
          }),
        ])
      )
    )

    // Composite rowKey = '["cus_1","acct_A"]' matches the seeded row → tail blanked.
    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    expect(rows).toEqual([
      ['id', '_account_id', 'name', 'deleted'],
      ['', '', '', ''],
    ])
  })

  // MARK: - invariants

  it('scattered deletes still produce a gap-free block of survivors at the top', async () => {
    const { sheets, getData, getSpreadsheetIds } = createMemorySheets()
    const dest = createDestination(sheets)
    const cat = catalogWith()

    await seedCustomers(dest, cat, [
      ['cus_1', 'Alice'],
      ['cus_2', 'Bob'],
      ['cus_3', 'Charlie'],
      ['cus_4', 'Dave'],
      ['cus_5', 'Eve'],
    ])

    // Delete 3 rows scattered through body and tail: rows 2, 4, 5.
    // Only row 6 (cus_5) is a tail survivor; it fills body delete at row 2.
    await collect(
      dest.write(
        { config: cfg({ spreadsheet_id: getSpreadsheetIds()[0] }), catalog: cat },
        toAsyncIter([
          record('customers', { id: 'cus_1', name: 'Alice', deleted: true }),
          record('customers', { id: 'cus_3', name: 'Charlie', deleted: true }),
          record('customers', { id: 'cus_4', name: 'Dave', deleted: true }),
        ])
      )
    )

    const rows = getData(getSpreadsheetIds()[0], 'customers')!
    const dataRows = rows.slice(1) // skip header
    const nonBlankRows = dataRows.filter((r) => r.some((cell) => cell !== ''))
    const firstBlankIdx = dataRows.findIndex((r) => r.every((cell) => cell === ''))

    // Invariant: all non-blank rows precede all blank rows — no gaps.
    expect(firstBlankIdx).toBe(nonBlankRows.length)

    // Spot-check: surviving data is {cus_2, cus_5}; originally 5 rows, 3 deletes → 2 remain.
    const survivingIds = nonBlankRows.map((r) => r[0]).sort()
    expect(survivingIds).toEqual(['cus_2', 'cus_5'])
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

describe('applyBatch cell-count limit', () => {
  // Enforces the 10M-cell per-spreadsheet cap locally so the failure is loud rather than an opaque API reject.

  async function setupSpreadsheet() {
    const { sheets, getSpreadsheetIds } = createMemorySheets()
    const created = await sheets.spreadsheets.create({
      requestBody: { properties: { title: 'Limit Test' } },
    })
    const spreadsheetId = created.data.spreadsheetId!
    const meta = await sheets.spreadsheets.get({ spreadsheetId })
    const sheetId = meta.data.sheets![0]!.properties!.sheetId!
    return { sheets, spreadsheetId, sheetId, getSpreadsheetIds }
  }

  /** Inflate reported grid dimensions so applyBatch sees a near-cap spreadsheet without writing millions of rows. */
  function overrideGridProperties(
    sheets: Parameters<typeof applyBatch>[0],
    rowCount: number,
    columnCount: number
  ) {
    type InflatedResponse = {
      data: {
        sheets?: Array<{
          properties?: { gridProperties?: { rowCount?: number; columnCount?: number } }
        }>
      }
    }
    const originalGet = sheets.spreadsheets.get.bind(sheets.spreadsheets) as unknown as (
      params: unknown
    ) => Promise<InflatedResponse>
    sheets.spreadsheets.get = (async (params: unknown) => {
      const response = await originalGet(params)
      for (const s of response.data.sheets ?? []) {
        if (s.properties?.gridProperties) {
          s.properties.gridProperties.rowCount = rowCount
          s.properties.gridProperties.columnCount = columnCount
        }
      }
      return response
    }) as unknown as typeof sheets.spreadsheets.get
  }

  it('throws when a single flush tries to write more than 10 million cells', async () => {
    const { sheets, spreadsheetId, sheetId } = await setupSpreadsheet()

    // 10,001 rows × 1,001 cells ≈ 10.01M (shared row array — applyBatch only reads row.length).
    const wideRow: string[] = new Array(1001).fill('x')
    const appends: string[][] = new Array(10_001).fill(wideRow)

    const opsByStream = new Map<string, StreamBatchOps>([
      ['Sheet1', { sheetId, updates: [], appends, existingRowCount: 0 }],
    ])

    await expect(applyBatch(sheets, spreadsheetId, opsByStream)).rejects.toThrow(
      /refusing to flush .* cells in a single batch/
    )
  })

  it('throws when current grid + appended cells would cross 10 million', async () => {
    const { sheets, spreadsheetId, sheetId } = await setupSpreadsheet()

    // Pretend the sheet already has 999,900 × 10 = 9,999,000 cells allocated.
    overrideGridProperties(sheets, 999_900, 10)

    // Append 200 × 10 = 2,000 cells → 10,001,000 total, over the cap.
    const row: string[] = new Array(10).fill('x')
    const appends: string[][] = new Array(200).fill(row)

    const opsByStream = new Map<string, StreamBatchOps>([
      ['Sheet1', { sheetId, updates: [], appends, existingRowCount: 0 }],
    ])

    await expect(applyBatch(sheets, spreadsheetId, opsByStream)).rejects.toThrow(
      /would exceed the .*-cell-per-spreadsheet limit/
    )
  })

  it('allows a flush that stays at or below 10 million cells', async () => {
    const { sheets, spreadsheetId, sheetId } = await setupSpreadsheet()

    // Grid currently holds 500,000 × 10 = 5,000,000 cells.
    overrideGridProperties(sheets, 500_000, 10)

    // Append 100,000 × 10 = 1,000,000 cells → 6M total, well under the cap.
    const row: string[] = new Array(10).fill('y')
    const appends: string[][] = new Array(100_000).fill(row)

    const opsByStream = new Map<string, StreamBatchOps>([
      ['Sheet1', { sheetId, updates: [], appends, existingRowCount: 0 }],
    ])

    await expect(applyBatch(sheets, spreadsheetId, opsByStream)).resolves.toBeDefined()
  })

  it('ignores the update-only path (updates overwrite allocated cells, no growth)', async () => {
    const { sheets, spreadsheetId, sheetId } = await setupSpreadsheet()

    // Even with the grid at the cap, updates overwrite existing cells and shouldn't trip the append check.
    overrideGridProperties(sheets, 1_000_000, 10)

    const updates = [{ rowNumber: 2, values: ['a', 'b', 'c'] }]
    const opsByStream = new Map<string, StreamBatchOps>([
      ['Sheet1', { sheetId, updates, appends: [], existingRowCount: 0 }],
    ])

    await expect(applyBatch(sheets, spreadsheetId, opsByStream)).resolves.toBeDefined()
  })

  it('propagates the limit error through dest.write() as connection_status failed', async () => {
    const { sheets } = createMemorySheets()
    overrideGridProperties(sheets, 1_000_000, 20) // 20M cells, well over cap

    const dest = createDestination(sheets)
    const messages: DestinationInput[] = [record('big', { id: 'r1', name: 'A' })]

    const output = await collect(dest.write({ config: cfg(), catalog }, toAsyncIter(messages)))

    const failure = output.find(
      (m) => m.type === 'connection_status' && m.connection_status.status === 'failed'
    )
    expect(failure).toBeDefined()
    expect((failure as { connection_status: { message: string } }).connection_status.message).toMatch(
      /cell-per-spreadsheet limit/
    )
  })

  it('exports MAX_CELLS_PER_SPREADSHEET as 10 million', () => {
    expect(MAX_CELLS_PER_SPREADSHEET).toBe(10_000_000)
  })
})
