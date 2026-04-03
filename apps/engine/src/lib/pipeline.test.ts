import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ConfiguredCatalog, DestinationOutput, Message } from '@stripe/sync-protocol'
import {
  enforceCatalog,
  filterType,
  log,
  persistState,
  pipe,
  takeStateCheckpoints,
} from './pipeline.js'
import type { StateStore } from './state-store.js'

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}))

import { logger } from '../logger.js'

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iter) result.push(item)
  return result
}

function catalog(
  streams: Array<{ name: string; fields?: string[]; json_schema?: Record<string, unknown> }>
): ConfiguredCatalog {
  return {
    streams: streams.map((s) => ({
      stream: { name: s.name, primary_key: [['id']], json_schema: s.json_schema },
      sync_mode: 'full_refresh',
      destination_sync_mode: 'append',
      fields: s.fields,
    })),
  }
}

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

// ---------------------------------------------------------------------------
// enforceCatalog()
// ---------------------------------------------------------------------------

describe('enforceCatalog()', () => {
  it('passes known record messages through unchanged when no fields configured', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1', name: 'Alice' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
    ]
    const result = await drain(enforceCatalog(catalog([{ name: 'customers' }]))(toAsync(msgs)))
    expect(result).toHaveLength(1)
    expect((result[0] as { data: unknown }).data).toEqual({ id: 'cus_1', name: 'Alice' })
  })

  it('filters record fields to json_schema.properties when present', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        stream: 'subscriptions',
        data: { id: 'sub_1', status: 'active', customer: 'cus_1' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
    ]
    const result = await drain(
      enforceCatalog(
        catalog([
          {
            name: 'subscriptions',
            json_schema: {
              type: 'object',
              properties: { id: { type: 'string' }, status: { type: 'string' } },
            },
          },
        ])
      )(toAsync(msgs))
    )
    expect(result).toHaveLength(1)
    expect((result[0] as { data: unknown }).data).toEqual({ id: 'sub_1', status: 'active' })
  })

  it('passes records through unchanged when json_schema is absent', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        stream: 'subscriptions',
        data: { id: 'sub_1', status: 'active', customer: 'cus_1' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
    ]
    const result = await drain(enforceCatalog(catalog([{ name: 'subscriptions' }]))(toAsync(msgs)))
    expect(result).toHaveLength(1)
    expect((result[0] as { data: unknown }).data).toEqual({
      id: 'sub_1',
      status: 'active',
      customer: 'cus_1',
    })
  })

  it('drops record with unknown stream and logs error', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        stream: 'unknown_stream',
        data: { id: '1' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
    ]
    const result = await drain(enforceCatalog(catalog([{ name: 'customers' }]))(toAsync(msgs)))
    expect(result).toHaveLength(0)
    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith(
      { stream: 'unknown_stream' },
      'Unknown stream not in catalog'
    )
  })

  it('drops state with unknown stream and logs error', async () => {
    const msgs: Message[] = [{ type: 'state', stream: 'nonexistent', data: { cursor: 'x' } }]
    const result = await drain(enforceCatalog(catalog([{ name: 'customers' }]))(toAsync(msgs)))
    expect(result).toHaveLength(0)
    expect(logger.error).toHaveBeenCalledWith(
      { stream: 'nonexistent' },
      'Unknown stream not in catalog'
    )
  })

  it('passes non-data messages (log, error, stream_status) through unchanged', async () => {
    const msgs: Message[] = [
      { type: 'log', level: 'info', message: 'hello' },
      { type: 'error', failure_type: 'system_error', message: 'oops' },
      { type: 'stream_status', stream: 'customers', status: 'complete' },
    ]
    const result = await drain(
      enforceCatalog(catalog([{ name: 'customers', fields: ['id'] }]))(toAsync(msgs))
    )
    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: 'log' })
    expect(result[1]).toMatchObject({ type: 'error' })
    expect(result[2]).toMatchObject({ type: 'stream_status' })
  })
})

// ---------------------------------------------------------------------------
// log()
// ---------------------------------------------------------------------------

describe('log()', () => {
  it('passes all message types through unchanged', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
      { type: 'state', stream: 'customers', data: { cursor: 'abc' } },
      { type: 'log', level: 'info', message: 'hello' },
      { type: 'error', failure_type: 'system_error', message: 'oops' },
      { type: 'stream_status', stream: 'customers', status: 'complete' },
    ]
    const result = await drain(log(toAsync(msgs)))
    expect(result).toHaveLength(5)
    expect(result[0]).toMatchObject({ type: 'record' })
    expect(result[1]).toMatchObject({ type: 'state' })
    expect(result[2]).toMatchObject({ type: 'log' })
    expect(result[3]).toMatchObject({ type: 'error' })
    expect(result[4]).toMatchObject({ type: 'stream_status' })
  })

  it('logs log messages via logger at the correct level', async () => {
    const msgs: Message[] = [{ type: 'log', level: 'warn', message: 'careful' }]
    await drain(log(toAsync(msgs)))
    expect(logger.warn).toHaveBeenCalledWith('careful')
  })

  it('logs error messages via logger.error', async () => {
    const msgs: Message[] = [{ type: 'error', failure_type: 'transient_error', message: 'retry' }]
    await drain(log(toAsync(msgs)))
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ failure_type: 'transient_error' }),
      'retry'
    )
  })

  it('logs stream_status messages via logger.info', async () => {
    const msgs: Message[] = [{ type: 'stream_status', stream: 'orders', status: 'running' }]
    await drain(log(toAsync(msgs)))
    expect(logger.info).toHaveBeenCalledWith(
      { stream: 'orders', status: 'running' },
      'stream_status'
    )
  })

  it('does not log record or state messages', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
      { type: 'state', stream: 'customers', data: { cursor: 'abc' } },
    ]
    await drain(log(toAsync(msgs)))
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// filterType()
// ---------------------------------------------------------------------------

describe('filterType()', () => {
  it('filters to a single type', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
      { type: 'state', stream: 'customers', data: { cursor: 'abc' } },
      { type: 'log', level: 'info', message: 'hello' },
    ]
    const result = await drain(filterType('record')(toAsync(msgs)))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'record' })
  })

  it('filters to multiple types', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
      { type: 'state', stream: 'customers', data: { cursor: 'abc' } },
      { type: 'log', level: 'info', message: 'hello' },
      { type: 'error', failure_type: 'system_error', message: 'oops' },
    ]
    const result = await drain(filterType('record', 'state')(toAsync(msgs)))
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: 'record' })
    expect(result[1]).toMatchObject({ type: 'state' })
  })

  it('returns empty when nothing matches', async () => {
    const msgs: Message[] = [
      { type: 'log', level: 'info', message: 'hello' },
      { type: 'error', failure_type: 'system_error', message: 'oops' },
    ]
    const result = await drain(filterType('record')(toAsync(msgs)))
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// persistState()
// ---------------------------------------------------------------------------

describe('persistState()', () => {
  it('calls store.set for state messages', async () => {
    const calls: Array<{ stream: string; data: unknown }> = []
    const store: StateStore = {
      get: async () => undefined,
      set: async (stream, data) => {
        calls.push({ stream, data })
      },
    }
    const msgs: DestinationOutput[] = [
      { type: 'state', stream: 'customers', data: { cursor: 'abc' } },
    ]
    await drain(persistState(store)(toAsync(msgs)))
    expect(calls).toEqual([{ stream: 'customers', data: { cursor: 'abc' } }])
  })

  it('yields all messages through unchanged', async () => {
    const store: StateStore = { get: async () => undefined, set: async () => {} }
    const msgs: DestinationOutput[] = [
      { type: 'state', stream: 'customers', data: { cursor: 'abc' } },
      { type: 'log', level: 'info', message: 'done' },
    ]
    const result = await drain(persistState(store)(toAsync(msgs)))
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: 'state' })
    expect(result[1]).toMatchObject({ type: 'log' })
  })

  it('does not call store.set for non-state messages', async () => {
    const calls: Array<unknown> = []
    const store: StateStore = {
      get: async () => undefined,
      set: async (...args) => {
        calls.push(args)
      },
    }
    const msgs: DestinationOutput[] = [
      { type: 'log', level: 'info', message: 'hello' },
      { type: 'error', failure_type: 'system_error', message: 'oops' },
    ]
    await drain(persistState(store)(toAsync(msgs)))
    expect(calls).toHaveLength(0)
  })

  it('persists multiple state messages in order', async () => {
    const calls: Array<{ stream: string; data: unknown }> = []
    const store: StateStore = {
      get: async () => undefined,
      set: async (stream, data) => {
        calls.push({ stream, data })
      },
    }
    const msgs: DestinationOutput[] = [
      { type: 'state', stream: 'customers', data: { cursor: '1' } },
      { type: 'state', stream: 'invoices', data: { cursor: '2' } },
      { type: 'state', stream: 'customers', data: { cursor: '3' } },
    ]
    await drain(persistState(store)(toAsync(msgs)))
    expect(calls).toEqual([
      { stream: 'customers', data: { cursor: '1' } },
      { stream: 'invoices', data: { cursor: '2' } },
      { stream: 'customers', data: { cursor: '3' } },
    ])
  })
})

// ---------------------------------------------------------------------------
// takeStateCheckpoints()
// ---------------------------------------------------------------------------

describe('takeStateCheckpoints()', () => {
  it('stops after the Nth state message', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
      { type: 'state', stream: 'customers', data: { cursor: '1' } },
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_2' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
      { type: 'state', stream: 'customers', data: { cursor: '2' } },
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_3' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
    ]
    const result = await drain(takeStateCheckpoints<Message>(1)(toAsync(msgs)))
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: 'record', data: { id: 'cus_1' } })
    expect(result[1]).toMatchObject({ type: 'state', data: { cursor: '1' } })
  })

  it('yields everything when limit exceeds state message count', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
      { type: 'state', stream: 'customers', data: { cursor: '1' } },
    ]
    const result = await drain(takeStateCheckpoints<Message>(5)(toAsync(msgs)))
    expect(result).toHaveLength(2)
  })

  it('counts state messages across multiple streams', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
      { type: 'state', stream: 'customers', data: { cursor: 'a' } },
      {
        type: 'record',
        stream: 'products',
        data: { id: 'prod_1' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
      { type: 'state', stream: 'products', data: { cursor: 'b' } },
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_2' },
        emitted_at: '2024-01-01T00:00:00.000Z',
      },
      { type: 'state', stream: 'customers', data: { cursor: 'c' } },
    ]
    const result = await drain(takeStateCheckpoints<Message>(2)(toAsync(msgs)))
    expect(result).toHaveLength(4)
    expect(result[3]).toMatchObject({ type: 'state', stream: 'products' })
  })

  it('yields the state message itself before stopping', async () => {
    const msgs: Message[] = [{ type: 'state', stream: 'customers', data: { cursor: '1' } }]
    const result = await drain(takeStateCheckpoints<Message>(1)(toAsync(msgs)))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'state' })
  })
})

// ---------------------------------------------------------------------------
// pipe()
// ---------------------------------------------------------------------------

describe('pipe()', () => {
  it('with no transforms returns the source unchanged', async () => {
    const src = toAsync([1, 2, 3])
    const result = await drain(pipe(src))
    expect(result).toEqual([1, 2, 3])
  })

  it('chains two transforms in order', async () => {
    async function* double(src: AsyncIterable<number>): AsyncIterable<number> {
      for await (const n of src) yield n * 2
    }
    async function* addOne(src: AsyncIterable<number>): AsyncIterable<number> {
      for await (const n of src) yield n + 1
    }
    const result = await drain(pipe(toAsync([1, 2, 3]), double, addOne))
    expect(result).toEqual([3, 5, 7])
  })

  it('chains three transforms in order', async () => {
    async function* toStr(src: AsyncIterable<number>): AsyncIterable<string> {
      for await (const n of src) yield String(n)
    }
    async function* double(src: AsyncIterable<number>): AsyncIterable<number> {
      for await (const n of src) yield n * 2
    }
    async function* addOne(src: AsyncIterable<number>): AsyncIterable<number> {
      for await (const n of src) yield n + 1
    }
    const result = await drain(pipe(toAsync([1, 2, 3]), double, addOne, toStr))
    expect(result).toEqual(['3', '5', '7'])
  })
})
