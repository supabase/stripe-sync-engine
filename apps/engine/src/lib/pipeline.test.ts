import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ConfiguredCatalog, DestinationOutput, Message } from '@stripe/sync-protocol'
import { enforceCatalog, filterType, tapLog, persistState, pipe, takeLimits } from './pipeline.js'
import type { StateStore } from './state-store.js'

vi.mock('../log.js', () => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}))

import { log } from '../log.js'

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
        record: {
          stream: 'customers',
          data: { id: 'cus_1', name: 'Alice' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
    ]
    const result = await drain(enforceCatalog(catalog([{ name: 'customers' }]))(toAsync(msgs)))
    expect(result).toHaveLength(1)
    expect((result[0] as any).record.data).toEqual({ id: 'cus_1', name: 'Alice' })
  })

  it('filters record fields to json_schema.properties when present', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        record: {
          stream: 'subscriptions',
          data: { id: 'sub_1', status: 'active', customer: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
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
    expect((result[0] as any).record.data).toEqual({ id: 'sub_1', status: 'active' })
  })

  it('drops unknown internal fields that are not present in the catalog schema', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        record: {
          stream: 'subscriptions',
          data: {
            id: 'sub_1',
            status: 'active',
            customer: 'cus_1',
            _row_key: '["sub_1"]',
            _row_number: 12,
          },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
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
    expect((result[0] as any).record.data).toEqual({
      id: 'sub_1',
      status: 'active',
    })
  })

  it('passes records through unchanged when json_schema is absent', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        record: {
          stream: 'subscriptions',
          data: { id: 'sub_1', status: 'active', customer: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
    ]
    const result = await drain(enforceCatalog(catalog([{ name: 'subscriptions' }]))(toAsync(msgs)))
    expect(result).toHaveLength(1)
    expect((result[0] as any).record.data).toEqual({
      id: 'sub_1',
      status: 'active',
      customer: 'cus_1',
    })
  })

  it('drops record with unknown stream and logs error', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        record: {
          stream: 'unknown_stream',
          data: { id: '1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
    ]
    const result = await drain(enforceCatalog(catalog([{ name: 'customers' }]))(toAsync(msgs)))
    expect(result).toHaveLength(0)
    expect(log.error).toHaveBeenCalledOnce()
    expect(log.error).toHaveBeenCalledWith(
      { stream: 'unknown_stream' },
      'Unknown stream not in catalog'
    )
  })

  it('drops state with unknown stream and logs error', async () => {
    const msgs: Message[] = [
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'nonexistent', data: { cursor: 'x' } },
      },
    ]
    const result = await drain(enforceCatalog(catalog([{ name: 'customers' }]))(toAsync(msgs)))
    expect(result).toHaveLength(0)
    expect(log.error).toHaveBeenCalledWith(
      { stream: 'nonexistent' },
      'Unknown stream not in catalog'
    )
  })

  it('passes global state messages through without catalog validation', async () => {
    const msgs: Message[] = [
      {
        type: 'source_state',
        source_state: { state_type: 'global', data: { events_cursor: 'evt_1' } },
      },
    ]
    // Empty catalog — no streams configured at all
    const result = await drain(enforceCatalog(catalog([]))(toAsync(msgs)))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'source_state',
      source_state: { state_type: 'global', data: { events_cursor: 'evt_1' } },
    })
  })

  it('passes non-data messages (log, connection_status, stream_status) through unchanged', async () => {
    const msgs: Message[] = [
      { type: 'log', log: { level: 'info', message: 'hello' } },
      {
        type: 'connection_status',
        connection_status: { status: 'failed', message: 'oops' },
      },
      {
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'complete' },
      },
    ]
    const result = await drain(
      enforceCatalog(catalog([{ name: 'customers', fields: ['id'] }]))(toAsync(msgs))
    )
    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: 'log' })
    expect(result[1]).toMatchObject({ type: 'connection_status' })
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
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'abc' } },
      },
      { type: 'log', log: { level: 'info', message: 'hello' } },
      {
        type: 'connection_status',
        connection_status: { status: 'failed', message: 'oops' },
      },
      {
        type: 'stream_status',
        stream_status: { stream: 'customers', status: 'complete' },
      },
    ]
    const result = await drain(log(toAsync(msgs)))
    expect(result).toHaveLength(5)
    expect(result[0]).toMatchObject({ type: 'record' })
    expect(result[1]).toMatchObject({ type: 'source_state' })
    expect(result[2]).toMatchObject({ type: 'log' })
    expect(result[3]).toMatchObject({ type: 'connection_status' })
    expect(result[4]).toMatchObject({ type: 'stream_status' })
  })

  it('logs log messages via logger at the correct level', async () => {
    const msgs: Message[] = [
      { type: 'log', log: { level: 'warn', message: 'careful', data: { stream: 'customers' } } },
    ]
    await drain(log(toAsync(msgs)))
    expect(log.warn).toHaveBeenCalledWith({ stream: 'customers' }, 'careful')
  })

  it('logs top-level stream_status messages via log.debug', async () => {
    const msgs: Message[] = [
      {
        type: 'stream_status',
        stream_status: { stream: 'orders', status: 'start' },
      },
    ]
    await drain(log(toAsync(msgs)))
    expect(log.debug).toHaveBeenCalledWith(
      { stream: 'orders', status: 'start' },
      'stream_status'
    )
  })

  it('does not log record or state messages', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'abc' } },
      },
    ]
    await drain(log(toAsync(msgs)))
    expect(log.info).not.toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
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
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'abc' } },
      },
      { type: 'log', log: { level: 'info', message: 'hello' } },
    ]
    const result = await drain(filterType('record')(toAsync(msgs)))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'record' })
  })

  it('filters to multiple types', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'abc' } },
      },
      { type: 'log', log: { level: 'info', message: 'hello' } },
      {
        type: 'connection_status',
        connection_status: { status: 'failed', message: 'oops' },
      },
    ]
    const result = await drain(filterType('record', 'source_state')(toAsync(msgs)))
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: 'record' })
    expect(result[1]).toMatchObject({ type: 'source_state' })
  })

  it('returns empty when nothing matches', async () => {
    const msgs: Message[] = [
      { type: 'log', log: { level: 'info', message: 'hello' } },
      {
        type: 'connection_status',
        connection_status: { status: 'failed', message: 'oops' },
      },
    ]
    const result = await drain(filterType('record')(toAsync(msgs)))
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// persistState()
// ---------------------------------------------------------------------------

describe('persistState()', () => {
  it('calls store.set for stream state messages', async () => {
    const calls: Array<{ stream: string; data: unknown }> = []
    const store: StateStore = {
      get: async () => undefined,
      set: async (stream, data) => {
        calls.push({ stream, data })
      },
      setGlobal: async () => {},
    }
    const msgs: DestinationOutput[] = [
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'abc' } },
      },
    ]
    await drain(persistState(store)(toAsync(msgs)))
    expect(calls).toEqual([{ stream: 'customers', data: { cursor: 'abc' } }])
  })

  it('yields all messages through unchanged', async () => {
    const store: StateStore = {
      get: async () => undefined,
      set: async () => {},
      setGlobal: async () => {},
    }
    const msgs: DestinationOutput[] = [
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'abc' } },
      },
      { type: 'log', log: { level: 'info', message: 'done' } },
    ]
    const result = await drain(persistState(store)(toAsync(msgs)))
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: 'source_state' })
    expect(result[1]).toMatchObject({ type: 'log' })
  })

  it('does not call store.set for non-state messages', async () => {
    const calls: Array<unknown> = []
    const store: StateStore = {
      get: async () => undefined,
      set: async (...args) => {
        calls.push(args)
      },
      setGlobal: async () => {},
    }
    const msgs: DestinationOutput[] = [
      { type: 'log', log: { level: 'info', message: 'hello' } },
      {
        type: 'connection_status',
        connection_status: { status: 'failed', message: 'oops' },
      },
    ]
    await drain(persistState(store)(toAsync(msgs)))
    expect(calls).toHaveLength(0)
  })

  it('calls store.setGlobal for global state messages', async () => {
    const globalCalls: unknown[] = []
    const setCalls: Array<{ stream: string; data: unknown }> = []
    const store: StateStore = {
      get: async () => undefined,
      set: async (stream, data) => {
        setCalls.push({ stream, data })
      },
      setGlobal: async (data) => {
        globalCalls.push(data)
      },
    }
    const msgs: DestinationOutput[] = [
      {
        type: 'source_state',
        source_state: { state_type: 'global', data: { events_cursor: 'evt_123' } },
      },
    ]
    await drain(persistState(store)(toAsync(msgs)))
    expect(globalCalls).toEqual([{ events_cursor: 'evt_123' }])
    expect(setCalls).toHaveLength(0)
  })

  it('persists multiple state messages in order', async () => {
    const calls: Array<{ stream: string; data: unknown }> = []
    const store: StateStore = {
      get: async () => undefined,
      set: async (stream, data) => {
        calls.push({ stream, data })
      },
      setGlobal: async () => {},
    }
    const msgs: DestinationOutput[] = [
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '1' } },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'invoices', data: { cursor: '2' } },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '3' } },
      },
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
// takeLimits()
// ---------------------------------------------------------------------------

describe('takeLimits()', () => {
  it('stops after N state messages and emits eof with state_limit reason', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '1' } },
      },
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_2' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '2' } },
      },
    ]
    const result = await drain(takeLimits({ state_limit: 1 })(toAsync(msgs)))
    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: 'record', record: { data: { id: 'cus_1' } } })
    expect(result[1]).toMatchObject({
      type: 'source_state',
      source_state: { data: { cursor: '1' } },
    })
    expect(result[2]).toMatchObject({
      type: 'eof',
      eof: { has_more: true },
    })
  })

  it('emits eof with complete reason when source exhausts', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '1' } },
      },
    ]
    const result = await drain(takeLimits({ state_limit: 5 })(toAsync(msgs)))
    expect(result).toHaveLength(3)
    expect(result[2]).toMatchObject({
      type: 'eof',
      eof: { has_more: false },
    })
  })

  it('emits eof complete with no limits set', async () => {
    const msgs: Message[] = [
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '1' } },
      },
    ]
    const result = await drain(takeLimits()(toAsync(msgs)))
    expect(result).toHaveLength(2)
    expect(result[1]).toMatchObject({ type: 'eof', eof: { has_more: false } })
  })

  it('counts state messages across multiple streams', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'a' } },
      },
      {
        type: 'record',
        record: {
          stream: 'products',
          data: { id: 'prod_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'products', data: { cursor: 'b' } },
      },
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_2' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'c' } },
      },
    ]
    const result = await drain(takeLimits({ state_limit: 2 })(toAsync(msgs)))
    expect(result).toHaveLength(5)
    expect(result[3]).toMatchObject({
      type: 'source_state',
      source_state: { state_type: 'stream', stream: 'products' },
    })
    expect(result[4]).toMatchObject({
      type: 'eof',
      eof: { has_more: true },
    })
  })

  it('stops on time limit at any message boundary (short time_limit)', async () => {
    async function* slowMessages(): AsyncIterable<Message> {
      yield {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      }
      await new Promise((r) => setTimeout(r, 60))
      yield {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_2' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      }
      yield {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '2' } },
      }
    }

    const result = await drain(takeLimits({ time_limit: 0.03 })(slowMessages()))
    expect(result.at(-1)).toMatchObject({ type: 'eof', eof: { has_more: true } })
    expect(result.length).toBeLessThanOrEqual(3)
  })

  it('soft cutoff: emits eof with time_limit reason between messages when deadline-1s crossed', async () => {
    async function* fastMessages(): AsyncIterable<Message> {
      let i = 0
      while (true) {
        yield {
          type: 'record',
          record: {
            stream: 'customers',
            data: { id: `cus_${++i}` },
            emitted_at: '2024-01-01T00:00:00.000Z',
          },
        }
        await new Promise((r) => setTimeout(r, 50))
      }
    }

    const start = Date.now()
    const result = await drain(takeLimits({ time_limit: 3 })(fastMessages()))
    const elapsed = Date.now() - start
    const eof = result.at(-1) as any
    expect(eof).toMatchObject({ type: 'eof', eof: { has_more: true } })
    // Soft deadline fires at ~2s (deadline - 1s buffer)
    expect(elapsed).toBeGreaterThan(1500)
    expect(elapsed).toBeLessThan(4000)
  })

  it('hard cutoff: forces return when source blocks past deadline+1s', async () => {
    async function* blockingSource(): AsyncIterable<Message> {
      yield {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      }
      // Block for 10 seconds — way past the hard deadline
      await new Promise((r) => setTimeout(r, 10_000))
      yield {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_2' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      }
    }

    const start = Date.now()
    const result = await drain(takeLimits({ time_limit: 2 })(blockingSource()))
    const elapsed = Date.now() - start
    const eof = result.at(-1) as any
    expect(eof).toMatchObject({ type: 'eof', eof: { has_more: true } })
    // Hard deadline fires at ~3s (deadline + 1s), NOT at 10s
    expect(elapsed).toBeGreaterThan(2000)
    expect(elapsed).toBeLessThan(5000)
  }, 10_000)

  it('abort signal: terminates immediately when signal is aborted', async () => {
    async function* infiniteSource(): AsyncIterable<Message> {
      let i = 0
      while (true) {
        yield {
          type: 'record',
          record: {
            stream: 'customers',
            data: { id: `cus_${++i}` },
            emitted_at: '2024-01-01T00:00:00.000Z',
          },
        }
        await new Promise((r) => setTimeout(r, 50))
      }
    }

    const ac = new AbortController()
    setTimeout(() => ac.abort(), 500)

    const start = Date.now()
    const result = await drain(takeLimits({ signal: ac.signal })(infiniteSource()))
    const elapsed = Date.now() - start
    const eof = result.at(-1) as any
    expect(eof).toMatchObject({ type: 'eof', eof: { has_more: true } })
    expect(elapsed).toBeGreaterThan(300)
    expect(elapsed).toBeLessThan(2000)
  })

  it('abort signal: terminates immediately when signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const msgs: Message[] = [
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
    ]
    const result = await drain(takeLimits({ signal: ac.signal })(toAsync(msgs)))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'eof', eof: { has_more: true } })
  })

  it('time_limit eof sets has_more: true', async () => {
    async function* slowMessages(): AsyncIterable<Message> {
      yield {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      }
      await new Promise((r) => setTimeout(r, 50))
      yield {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_2' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      }
      await new Promise((r) => setTimeout(r, 50))
      yield {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_3' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      }
    }
    const result = await drain(takeLimits({ time_limit: 0.03 })(slowMessages()))
    const eof = result.at(-1) as any
    expect(eof.eof.has_more).toBe(true)
  })

  it('time limit and state limit: whichever fires first wins', async () => {
    const msgs: Message[] = [
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '1' } },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '2' } },
      },
      {
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '3' } },
      },
    ]
    // State limit of 1 fires before any time limit
    const result = await drain(takeLimits({ state_limit: 1, time_limit: 60 })(toAsync(msgs)))
    expect(result.at(-1)).toMatchObject({ type: 'eof', eof: { has_more: true } })
  })

  it('emits eof for empty stream', async () => {
    const result = await drain(takeLimits()(toAsync([])))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'eof', eof: { has_more: false } })
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
