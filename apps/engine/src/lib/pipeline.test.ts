import { describe, expect, it, vi } from 'vitest'
import type { ConfiguredCatalog, DestinationOutput, Message } from '@stripe/sync-protocol'
import { enforceCatalog, filterType, log, persistState, pipe } from './pipeline.js'
import type { StateStore } from './state-store.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iter) result.push(item)
  return result
}

function catalog(streams: Array<{ name: string; fields?: string[] }>): ConfiguredCatalog {
  return {
    streams: streams.map((s) => ({
      stream: { name: s.name, primary_key: [['id']] },
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
      { type: 'record', stream: 'customers', data: { id: 'cus_1', name: 'Alice' }, emitted_at: 1 },
    ]
    const result = await drain(enforceCatalog(catalog([{ name: 'customers' }]))(toAsync(msgs)))
    expect(result).toHaveLength(1)
    expect((result[0] as { data: unknown }).data).toEqual({ id: 'cus_1', name: 'Alice' })
  })

  it('filters record fields to the configured allow-list', async () => {
    const msgs: Message[] = [
      {
        type: 'record',
        stream: 'subscriptions',
        data: { id: 'sub_1', status: 'active', customer: 'cus_1' },
        emitted_at: 1,
      },
    ]
    const result = await drain(
      enforceCatalog(catalog([{ name: 'subscriptions', fields: ['id', 'status'] }]))(toAsync(msgs))
    )
    expect(result).toHaveLength(1)
    expect((result[0] as { data: unknown }).data).toEqual({ id: 'sub_1', status: 'active' })
  })

  it('drops record with unknown stream and logs to stderr', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const msgs: Message[] = [
      { type: 'record', stream: 'unknown_stream', data: { id: '1' }, emitted_at: 1 },
    ]
    const result = await drain(enforceCatalog(catalog([{ name: 'customers' }]))(toAsync(msgs)))
    expect(result).toHaveLength(0)
    expect(stderrSpy).toHaveBeenCalledOnce()
    expect(stderrSpy).toHaveBeenCalledWith(
      '[error:system_error] Unknown stream "unknown_stream" not in catalog'
    )
    stderrSpy.mockRestore()
  })

  it('drops state with unknown stream and logs to stderr', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const msgs: Message[] = [{ type: 'state', stream: 'nonexistent', data: { cursor: 'x' } }]
    const result = await drain(enforceCatalog(catalog([{ name: 'customers' }]))(toAsync(msgs)))
    expect(result).toHaveLength(0)
    expect(stderrSpy).toHaveBeenCalledWith(
      '[error:system_error] Unknown stream "nonexistent" not in catalog'
    )
    stderrSpy.mockRestore()
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

  it('applies field filtering per-stream independently', async () => {
    const msgs: Message[] = [
      { type: 'record', stream: 'customers', data: { id: 'cus_1', name: 'Alice' }, emitted_at: 1 },
      {
        type: 'record',
        stream: 'products',
        data: { id: 'prod_1', name: 'Widget', active: true },
        emitted_at: 2,
      },
    ]
    const result = await drain(
      enforceCatalog(
        catalog([
          { name: 'customers', fields: ['id'] },
          { name: 'products' }, // no field filter
        ])
      )(toAsync(msgs))
    )
    expect(result).toHaveLength(2)
    expect((result[0] as { data: unknown }).data).toEqual({ id: 'cus_1' })
    expect((result[1] as { data: unknown }).data).toEqual({
      id: 'prod_1',
      name: 'Widget',
      active: true,
    })
  })
})

// ---------------------------------------------------------------------------
// log()
// ---------------------------------------------------------------------------

describe('log()', () => {
  it('passes all message types through unchanged', async () => {
    const msgs: Message[] = [
      { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: 1 },
      { type: 'state', stream: 'customers', data: { cursor: 'abc' } },
      { type: 'log', level: 'info', message: 'hello' },
      { type: 'error', failure_type: 'system_error', message: 'oops' },
      { type: 'stream_status', stream: 'customers', status: 'complete' },
    ]
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await drain(log(toAsync(msgs)))
    expect(result).toHaveLength(5)
    expect(result[0]).toMatchObject({ type: 'record' })
    expect(result[1]).toMatchObject({ type: 'state' })
    expect(result[2]).toMatchObject({ type: 'log' })
    expect(result[3]).toMatchObject({ type: 'error' })
    expect(result[4]).toMatchObject({ type: 'stream_status' })
    vi.restoreAllMocks()
  })

  it('logs log messages to stderr', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const msgs: Message[] = [{ type: 'log', level: 'warn', message: 'careful' }]
    await drain(log(toAsync(msgs)))
    expect(stderrSpy).toHaveBeenCalledWith('[warn] careful')
    stderrSpy.mockRestore()
  })

  it('logs error messages to stderr', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const msgs: Message[] = [{ type: 'error', failure_type: 'transient_error', message: 'retry' }]
    await drain(log(toAsync(msgs)))
    expect(stderrSpy).toHaveBeenCalledWith('[error:transient_error] retry')
    stderrSpy.mockRestore()
  })

  it('logs stream_status messages to stderr', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const msgs: Message[] = [{ type: 'stream_status', stream: 'orders', status: 'running' }]
    await drain(log(toAsync(msgs)))
    expect(stderrSpy).toHaveBeenCalledWith('[status] orders: running')
    stderrSpy.mockRestore()
  })

  it('does not log record or state messages', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const msgs: Message[] = [
      { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: 1 },
      { type: 'state', stream: 'customers', data: { cursor: 'abc' } },
    ]
    await drain(log(toAsync(msgs)))
    expect(stderrSpy).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// filterType()
// ---------------------------------------------------------------------------

describe('filterType()', () => {
  it('filters to a single type', async () => {
    const msgs: Message[] = [
      { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: 1 },
      { type: 'state', stream: 'customers', data: { cursor: 'abc' } },
      { type: 'log', level: 'info', message: 'hello' },
    ]
    const result = await drain(filterType('record')(toAsync(msgs)))
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'record' })
  })

  it('filters to multiple types', async () => {
    const msgs: Message[] = [
      { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: 1 },
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
    const store: StateStore = { set: async () => {} }
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
