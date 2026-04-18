import { describe, expect, it } from 'vitest'
import type { Message, SyncOutput } from '@stripe/sync-protocol'
import { createRecordCounter, mergeRanges, trackProgress } from './progress.js'

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iter) out.push(item)
  return out
}

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

describe('createRecordCounter', () => {
  it('counts records by stream on the data path', async () => {
    const counter = createRecordCounter()
    const records: Message[] = [
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
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

    const drained = await collect(counter.tap(toAsync(records)))
    expect(drained).toHaveLength(3)
    expect(counter.counts.get('customers')).toBe(2)
  })
})

describe('trackProgress', () => {
  it('emits enriched EOF with global and stream progress', async () => {
    const counter = createRecordCounter()
    await collect(
      counter.tap(
        toAsync<Message>([
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_1' },
              emitted_at: '2024-01-01T00:00:00.000Z',
            },
          },
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_2' },
              emitted_at: '2024-01-01T00:00:00.000Z',
            },
          },
        ])
      )
    )

    const outputs = await collect(
      trackProgress({
        interval_ms: 0,
        initial_cumulative_counts: { customers: 5 },
        recordCounter: counter,
      })(
        toAsync<SyncOutput>([
          {
            type: 'source_state',
            source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '2' } },
          },
          {
            type: 'stream_status',
            stream_status: { stream: 'customers', status: 'complete' },
          },
          {
            type: 'stream_status',
            stream_status: { stream: 'customers', status: 'error', error: 'boom' },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const progressMsgs = outputs.filter((m) => m.type === 'progress')
    expect(progressMsgs.length).toBeGreaterThan(0)

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toBeDefined()
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        reason: 'complete',
        state: {
          source: {
            streams: { customers: { cursor: '2' } },
            global: {},
          },
          destination: { streams: {}, global: {} },
          engine: {
            streams: { customers: { cumulative_record_count: 7 } },
            global: {},
          },
        },
        request_progress: {
          run_record_count: 2,
          state_checkpoint_count: 1,
        },
        stream_progress: {
          customers: {
            status: 'complete',
            cumulative_record_count: 7,
            run_record_count: 2,
            errors: [{ message: 'boom' }],
          },
        },
      },
    })
  })

  it('aggregates multiple stream states and global state into EOF', async () => {
    const counter = createRecordCounter()
    await collect(
      counter.tap(
        toAsync<Message>([
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_1' },
              emitted_at: '2024-01-01T00:00:00.000Z',
            },
          },
          {
            type: 'record',
            record: {
              stream: 'invoices',
              data: { id: 'inv_1' },
              emitted_at: '2024-01-01T00:00:00.000Z',
            },
          },
        ])
      )
    )

    const outputs = await collect(
      trackProgress({
        interval_ms: 0,
        recordCounter: counter,
      })(
        toAsync<SyncOutput>([
          {
            type: 'source_state',
            source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '1' } },
          },
          {
            type: 'source_state',
            source_state: { state_type: 'stream', stream: 'invoices', data: { cursor: 'a' } },
          },
          {
            type: 'source_state',
            source_state: { state_type: 'stream', stream: 'customers', data: { cursor: '3' } },
          },
          {
            type: 'source_state',
            source_state: {
              state_type: 'global',
              data: { events_cursor: 'evt_123' },
            },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toBeDefined()
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        reason: 'complete',
        state: {
          source: {
            streams: {
              customers: { cursor: '3' },
              invoices: { cursor: 'a' },
            },
            global: { events_cursor: 'evt_123' },
          },
          destination: { streams: {}, global: {} },
          engine: {
            streams: {
              customers: { cumulative_record_count: 1 },
              invoices: { cumulative_record_count: 1 },
            },
            global: {},
          },
        },
      },
    })
  })

  it('merges eof state into the provided initial sync state', async () => {
    const counter = createRecordCounter()
    await collect(
      counter.tap(
        toAsync<Message>([
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_1' },
              emitted_at: '2024-01-01T00:00:00.000Z',
            },
          },
        ])
      )
    )

    const outputs = await collect(
      trackProgress({
        interval_ms: 0,
        initial_state: {
          source: {
            streams: {
              customers: { cursor: 'cus_0' },
              invoices: { cursor: 'inv_2' },
            },
            global: { events_cursor: 'evt_old' },
          },
          destination: {
            streams: { customers: { watermark: 10 } },
            global: { schema_version: 1 },
          },
          engine: {
            streams: {
              customers: { cumulative_record_count: 5, note: 'keep-me' },
              invoices: { cumulative_record_count: 2, untouched: true },
            },
            global: { sync_id: 'prev' },
          },
        },
        recordCounter: counter,
      })(
        toAsync<SyncOutput>([
          {
            type: 'source_state',
            source_state: { state_type: 'stream', stream: 'customers', data: { cursor: 'cus_1' } },
          },
          {
            type: 'source_state',
            source_state: { state_type: 'global', data: { events_cursor: 'evt_new' } },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        state: {
          source: {
            streams: {
              customers: { cursor: 'cus_1' },
              invoices: { cursor: 'inv_2' },
            },
            global: { events_cursor: 'evt_new' },
          },
          destination: {
            streams: { customers: { watermark: 10 } },
            global: { schema_version: 1 },
          },
          engine: {
            streams: {
              customers: { cumulative_record_count: 6, note: 'keep-me' },
              invoices: { cumulative_record_count: 2, untouched: true },
            },
            global: { sync_id: 'prev' },
          },
        },
      },
    })
  })

  it('returns the initial sync state on a no-op resumed run', async () => {
    const initialState = {
      source: {
        streams: { customers: { cursor: 'cus_9' } },
        global: { events_cursor: 'evt_9' },
      },
      destination: {
        streams: { customers: { watermark: 99 } },
        global: { schema_version: 2 },
      },
      engine: {
        streams: { customers: { cumulative_record_count: 9 } },
        global: { sync_id: 'resume-9' },
      },
    }

    const outputs = await collect(
      trackProgress({
        interval_ms: 0,
        initial_state: initialState,
        recordCounter: createRecordCounter(),
      })(toAsync<SyncOutput>([{ type: 'eof', eof: { reason: 'complete' } }]))
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      type: 'eof',
      eof: { state: initialState },
    })
  })

  it('omits state from EOF when no source_state messages were emitted', async () => {
    const counter = createRecordCounter()
    const outputs = await collect(
      trackProgress({
        interval_ms: 0,
        recordCounter: counter,
      })(toAsync<SyncOutput>([{ type: 'eof', eof: { reason: 'complete' } }]))
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toBeDefined()
    expect((eof as any).eof.state).toBeUndefined()
  })

  it('accumulates range_complete into completed_ranges in engine state', async () => {
    const outputs = await collect(
      trackProgress({
        interval_ms: 999_999,
        recordCounter: createRecordCounter(),
      })(
        toAsync<SyncOutput>([
          {
            type: 'stream_status',
            stream_status: { stream: 'customers', status: 'start' },
          },
          {
            type: 'stream_status',
            stream_status: {
              stream: 'customers',
              status: 'range_complete',
              range_complete: { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
            },
          },
          {
            type: 'stream_status',
            stream_status: {
              stream: 'customers',
              status: 'range_complete',
              range_complete: { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
            },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        state: {
          engine: {
            streams: {
              customers: {
                completed_ranges: [{ gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' }],
              },
            },
          },
        },
      },
    })
  })

  it('range_complete does not overwrite stream status', async () => {
    const outputs = await collect(
      trackProgress({
        interval_ms: 999_999,
        recordCounter: createRecordCounter(),
      })(
        toAsync<SyncOutput>([
          {
            type: 'stream_status',
            stream_status: { stream: 'customers', status: 'start' },
          },
          {
            type: 'stream_status',
            stream_status: {
              stream: 'customers',
              status: 'range_complete',
              range_complete: { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
            },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        stream_progress: {
          customers: { status: 'start' },
        },
      },
    })
  })

  it('seeds completed_ranges from initial engine state', async () => {
    const outputs = await collect(
      trackProgress({
        interval_ms: 999_999,
        initial_state: {
          source: { streams: {}, global: {} },
          destination: { streams: {}, global: {} },
          engine: {
            streams: {
              customers: {
                completed_ranges: [{ gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' }],
              },
            },
            global: {},
          },
        },
        recordCounter: createRecordCounter(),
      })(
        toAsync<SyncOutput>([
          {
            type: 'stream_status',
            stream_status: {
              stream: 'customers',
              status: 'range_complete',
              range_complete: { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
            },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        state: {
          engine: {
            streams: {
              customers: {
                completed_ranges: [{ gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' }],
              },
            },
          },
        },
      },
    })
  })
})

describe('mergeRanges', () => {
  it('returns empty for empty input', () => {
    expect(mergeRanges([])).toEqual([])
  })

  it('returns single range unchanged', () => {
    const ranges = [{ gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' }]
    expect(mergeRanges(ranges)).toEqual(ranges)
  })

  it('merges adjacent ranges', () => {
    const ranges = [
      { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ]
    expect(mergeRanges(ranges)).toEqual([
      { gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ])
  })

  it('merges overlapping ranges', () => {
    const ranges = [
      { gte: '2024-01-01T00:00:00Z', lt: '2024-07-01T00:00:00Z' },
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ]
    expect(mergeRanges(ranges)).toEqual([
      { gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ])
  })

  it('keeps non-overlapping ranges separate', () => {
    const ranges = [
      { gte: '2024-01-01T00:00:00Z', lt: '2024-03-01T00:00:00Z' },
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ]
    expect(mergeRanges(ranges)).toEqual(ranges)
  })

  it('sorts and merges out-of-order ranges', () => {
    const ranges = [
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
      { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
    ]
    expect(mergeRanges(ranges)).toEqual([
      { gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ])
  })

  it('merges multiple overlapping ranges into one', () => {
    const ranges = [
      { gte: '2024-01-01T00:00:00Z', lt: '2024-04-01T00:00:00Z' },
      { gte: '2024-03-01T00:00:00Z', lt: '2024-07-01T00:00:00Z' },
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ]
    expect(mergeRanges(ranges)).toEqual([
      { gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
    ])
  })

  it('does not mutate input array', () => {
    const ranges = [
      { gte: '2024-06-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
      { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
    ]
    const original = JSON.parse(JSON.stringify(ranges))
    mergeRanges(ranges)
    expect(ranges).toEqual(original)
  })
})

describe('trackProgress — new message types', () => {
  it('accumulates stream_status: error into stream errors and sets status', async () => {
    const outputs = await collect(
      trackProgress({
        interval_ms: 999_999,
        recordCounter: createRecordCounter(),
      })(
        toAsync<SyncOutput>([
          {
            type: 'stream_status',
            stream_status: { stream: 'customers', status: 'start' },
          },
          {
            type: 'stream_status',
            stream_status: { stream: 'customers', status: 'error', error: 'Connection refused' },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        stream_progress: {
          customers: {
            status: 'complete', // error maps to complete in engine (stream is done)
            errors: [{ message: 'Connection refused' }],
          },
        },
      },
    })
  })

  it('tracks stream_status: skip', async () => {
    const outputs = await collect(
      trackProgress({
        interval_ms: 999_999,
        recordCounter: createRecordCounter(),
      })(
        toAsync<SyncOutput>([
          {
            type: 'stream_status',
            stream_status: {
              stream: 'invoices',
              status: 'skip',
              reason: 'only available in testmode',
            },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        stream_progress: {
          invoices: {
            status: 'skip',
            run_record_count: 0,
            cumulative_record_count: 0,
          },
        },
      },
    })
  })

  it('sets has_more: false when reason is complete', async () => {
    const outputs = await collect(
      trackProgress({
        interval_ms: 999_999,
        recordCounter: createRecordCounter(),
      })(toAsync<SyncOutput>([{ type: 'eof', eof: { reason: 'complete' } }]))
    )
    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({ eof: { has_more: false } })
  })

  it('sets has_more: true when reason is state_limit', async () => {
    const outputs = await collect(
      trackProgress({
        interval_ms: 999_999,
        recordCounter: createRecordCounter(),
      })(toAsync<SyncOutput>([{ type: 'eof', eof: { reason: 'state_limit' } }]))
    )
    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({ eof: { has_more: true } })
  })

  it('sets has_more: true when reason is time_limit', async () => {
    const outputs = await collect(
      trackProgress({
        interval_ms: 999_999,
        recordCounter: createRecordCounter(),
      })(toAsync<SyncOutput>([{ type: 'eof', eof: { reason: 'time_limit' } }]))
    )
    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({ eof: { has_more: true } })
  })

  it('passes through stream_status messages to output', async () => {
    const outputs = await collect(
      trackProgress({
        interval_ms: 999_999,
        recordCounter: createRecordCounter(),
      })(
        toAsync<SyncOutput>([
          {
            type: 'stream_status',
            stream_status: { stream: 'customers', status: 'start' },
          },
          {
            type: 'stream_status',
            stream_status: {
              stream: 'customers',
              status: 'range_complete',
              range_complete: { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
            },
          },
          {
            type: 'stream_status',
            stream_status: { stream: 'customers', status: 'complete' },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const streamStatuses = outputs.filter((m) => m.type === 'stream_status')
    expect(streamStatuses).toHaveLength(3)
    expect(streamStatuses[0]).toMatchObject({ stream_status: { status: 'start' } })
    expect(streamStatuses[1]).toMatchObject({ stream_status: { status: 'range_complete' } })
    expect(streamStatuses[2]).toMatchObject({ stream_status: { status: 'complete' } })

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toMatchObject({
      eof: {
        state: {
          engine: {
            streams: {
              customers: {
                status: 'complete',
                completed_ranges: [{ gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' }],
              },
            },
          },
        },
        stream_progress: {
          customers: { status: 'complete' },
        },
      },
    })
  })

  it('captures connection_status: failed from source', async () => {
    const outputs = await collect(
      trackProgress({
        interval_ms: 999_999,
        recordCounter: createRecordCounter(),
      })(
        toAsync<SyncOutput>([
          {
            type: 'connection_status',
            connection_status: { status: 'failed', message: 'Invalid API key' },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    // connection_status is passed through
    const connStatus = outputs.find((m) => m.type === 'connection_status')
    expect(connStatus).toMatchObject({
      connection_status: { status: 'failed', message: 'Invalid API key' },
    })
  })
})
