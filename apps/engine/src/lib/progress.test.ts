import { describe, expect, it } from 'vitest'
import type { Message, SyncOutput } from '@stripe/sync-protocol'
import { createRecordCounter, trackProgress } from './progress.js'

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
            type: 'trace',
            trace: {
              trace_type: 'stream_status',
              stream_status: { stream: 'customers', status: 'complete' },
            },
          },
          {
            type: 'trace',
            trace: {
              trace_type: 'error',
              error: { message: 'boom', failure_type: 'system_error', stream: 'customers' },
            },
          },
          { type: 'eof', eof: { reason: 'complete' } },
        ])
      )
    )

    const progressTraces = outputs.filter(
      (m) => m.type === 'trace' && m.trace.trace_type === 'progress'
    )
    expect(progressTraces.length).toBeGreaterThan(0)

    const eof = outputs.find((m) => m.type === 'eof')
    expect(eof).toBeDefined()
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        reason: 'complete',
        global_progress: {
          run_record_count: 2,
          state_checkpoint_count: 1,
        },
        stream_progress: {
          customers: {
            status: 'complete',
            cumulative_record_count: 7,
            run_record_count: 2,
            errors: [{ message: 'boom', failure_type: 'system_error' }],
          },
        },
        record_count: { customers: 2 },
      },
    })
  })
})
