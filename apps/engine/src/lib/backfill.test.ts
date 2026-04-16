import { describe, expect, it, vi } from 'vitest'
import type { Engine } from './engine.js'
import type { PipelineConfig, SyncOutput } from '@stripe/sync-protocol'
import { pipelineSyncUntilComplete } from './backfill.js'

const pipeline: PipelineConfig = {
  source: { type: 'test', test: {} },
  destination: { type: 'test', test: {} },
}

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

describe('pipelineSyncUntilComplete', () => {
  it('retries until eof complete and carries forward state', async () => {
    const calls: Array<unknown> = []
    const onState = vi.fn()
    const engine: Engine = {
      meta_sources_list: vi.fn(),
      meta_sources_get: vi.fn(),
      meta_destinations_list: vi.fn(),
      meta_destinations_get: vi.fn(),
      source_discover: vi.fn(),
      pipeline_check: vi.fn(),
      pipeline_setup: vi.fn(),
      pipeline_teardown: vi.fn(),
      pipeline_read: vi.fn(),
      pipeline_write: vi.fn(),
      pipeline_sync: vi.fn((_pipeline, opts) => {
        calls.push(opts?.state)
        const outputs: SyncOutput[] =
          calls.length === 1
            ? [
                {
                  type: 'source_state',
                  source_state: { stream: 'customers', data: { cursor: 'cus_1' } },
                },
                {
                  type: 'eof',
                  eof: {
                    reason: 'state_limit',
                    state: {
                      source: { streams: { customers: { cursor: 'cus_1' } }, global: {} },
                      destination: { streams: {}, global: {} },
                      engine: { streams: {}, global: {} },
                    },
                  },
                },
              ]
            : [{ type: 'eof', eof: { reason: 'complete' } }]
        return toAsync(outputs)
      }),
    } as unknown as Engine

    const result = await pipelineSyncUntilComplete(engine, pipeline, { state_limit: 1, onState })

    expect(calls).toEqual([
      undefined,
      {
        source: { streams: { customers: { cursor: 'cus_1' } }, global: {} },
        destination: { streams: {}, global: {} },
        engine: { streams: {}, global: {} },
      },
    ])
    expect(result.attempts).toBe(2)
    expect(result.eof.reason).toBe('complete')
    expect(onState).toHaveBeenLastCalledWith({
      source: { streams: { customers: { cursor: 'cus_1' } }, global: {} },
      destination: { streams: {}, global: {} },
      engine: { streams: {}, global: {} },
    }, 1)
  })

  it('throws when pipeline_sync ends with an unexpected eof reason', async () => {
    const engine: Engine = {
      meta_sources_list: vi.fn(),
      meta_sources_get: vi.fn(),
      meta_destinations_list: vi.fn(),
      meta_destinations_get: vi.fn(),
      source_discover: vi.fn(),
      pipeline_check: vi.fn(),
      pipeline_setup: vi.fn(),
      pipeline_teardown: vi.fn(),
      pipeline_read: vi.fn(),
      pipeline_write: vi.fn(),
      pipeline_sync: vi.fn(() => toAsync<SyncOutput>([{ type: 'eof', eof: { reason: 'aborted' } }])),
    } as unknown as Engine

    await expect(pipelineSyncUntilComplete(engine, pipeline)).rejects.toThrow(
      /unexpected eof reason: aborted/
    )
  })
})
