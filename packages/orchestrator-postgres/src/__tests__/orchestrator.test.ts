import { describe, expect, it, vi } from 'vitest'
import type {
  CatalogMessage,
  ConfiguredCatalog,
  Destination,
  DestinationInput,
  DestinationOutput,
  ErrorMessage,
  LogMessage,
  Message,
  RecordMessage,
  Source,
  StateMessage,
  StreamStatusMessage,
} from '@stripe/sync-protocol'
import { PostgresOrchestrator, type Sync } from '../orchestrator'
import { PostgresStateManager } from '../stateManager'
import { forward, collect } from '@stripe/sync-protocol'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert an array into an AsyncIterable. */
async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item
  }
}

/** Drain an AsyncIterable into an array. */
async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iter) {
    result.push(item)
  }
  return result
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/** A mock source that emits a predefined sequence of messages. */
function createMockSource(
  messages: Message[],
  catalog?: CatalogMessage
): { source: Source; readSpy: ReturnType<typeof vi.fn> } {
  const discoverCatalog: CatalogMessage = catalog ?? {
    type: 'catalog',
    streams: [{ name: 'customers', primary_key: [['id']] }],
  }
  const readSpy = vi.fn(
    (_params: {
      config: Record<string, unknown>
      catalog: ConfiguredCatalog
      state?: Record<string, unknown>
    }): AsyncIterable<Message> => {
      return toAsync(messages)
    }
  )

  const source: Source = {
    spec: () => ({ config: {} }),
    check: async () => ({ status: 'succeeded' as const }),
    async discover(_params: { config: Record<string, unknown> }): Promise<CatalogMessage> {
      return discoverCatalog
    },
    read: readSpy,
  }

  return { source, readSpy }
}

/**
 * A mock destination that tracks received messages and re-emits each
 * StateMessage it receives as output (simulating commit-then-checkpoint).
 */
function createMockDestination(): {
  destination: Destination
  received: DestinationInput[]
} {
  const received: DestinationInput[] = []

  const destination: Destination = {
    spec: () => ({ config: {} }),
    check: async () => ({ status: 'succeeded' as const }),
    async *write(
      params: { config: Record<string, unknown>; catalog: ConfiguredCatalog },
      messages: AsyncIterable<DestinationInput>
    ): AsyncIterable<DestinationOutput> {
      for await (const msg of messages) {
        received.push(msg)
        // After receiving a state message, re-emit it as output
        // (simulates: destination committed the batch, now checkpointing)
        if (msg.type === 'state') {
          yield msg
        }
      }
    },
  }

  return { destination, received }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const stubSync: Sync = {
  id: 'sync_001',
  account_id: 'acct_test',
  status: 'active',
  source: { type: 'stripe' },
  destination: { type: 'postgres' },
  streams: [{ name: 'customers' }],
}

/** Stub StateManager -- no pool needed since tested code paths never hit DB. */
const stubStateManager = new PostgresStateManager(
  null as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  { schema: 'public' }
)

const record1: RecordMessage = {
  type: 'record',
  stream: 'customers',
  data: { id: 'cus_1', name: 'Alice' },
  emitted_at: Date.now(),
}

const record2: RecordMessage = {
  type: 'record',
  stream: 'customers',
  data: { id: 'cus_2', name: 'Bob' },
  emitted_at: Date.now(),
}

const state1: StateMessage = {
  type: 'state',
  stream: 'customers',
  data: { cursor: '2024-01-01' },
}

const logMsg: LogMessage = {
  type: 'log',
  level: 'info',
  message: 'Sync started',
}

const errorMsg: ErrorMessage = {
  type: 'error',
  failure_type: 'transient_error',
  message: 'Rate limited',
}

const streamStatus: StreamStatusMessage = {
  type: 'stream_status',
  stream: 'customers',
  status: 'running',
}

const catalogMsg: CatalogMessage = {
  type: 'catalog',
  streams: [{ name: 'customers', primary_key: [['id']] }],
}

// ---------------------------------------------------------------------------
// Tests: PostgresOrchestrator class
// ---------------------------------------------------------------------------

describe('PostgresOrchestrator', () => {
  it('holds sync reference', () => {
    const orch = new PostgresOrchestrator(stubSync, stubStateManager)
    expect(orch.sync).toBe(stubSync)
    expect(orch.sync.id).toBe('sync_001')
    expect(orch.sync.account_id).toBe('acct_test')
  })
})

// ---------------------------------------------------------------------------
// Tests: forward()
// ---------------------------------------------------------------------------

describe('forward()', () => {
  it('yields RecordMessage', async () => {
    const result = await drain(forward(toAsync([record1])))
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(record1)
  })

  it('yields StateMessage', async () => {
    const result = await drain(forward(toAsync([state1])))
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(state1)
  })

  it('filters out LogMessage', async () => {
    const result = await drain(forward(toAsync([logMsg as Message])))
    expect(result).toHaveLength(0)
  })

  it('filters out ErrorMessage', async () => {
    const result = await drain(forward(toAsync([errorMsg as Message])))
    expect(result).toHaveLength(0)
  })

  it('filters out StreamStatusMessage', async () => {
    const result = await drain(forward(toAsync([streamStatus as Message])))
    expect(result).toHaveLength(0)
  })

  it('filters out CatalogMessage', async () => {
    const result = await drain(forward(toAsync([catalogMsg as Message])))
    expect(result).toHaveLength(0)
  })

  it('routes LogMessage to onLog callback', async () => {
    const onLog = vi.fn()
    await drain(forward(toAsync([logMsg as Message]), { onLog }))
    expect(onLog).toHaveBeenCalledOnce()
    expect(onLog).toHaveBeenCalledWith('Sync started', 'info')
  })

  it('routes ErrorMessage to onError callback', async () => {
    const onError = vi.fn()
    await drain(forward(toAsync([errorMsg as Message]), { onError }))
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith('Rate limited', 'transient_error')
  })

  it('handles empty stream', async () => {
    const result = await drain(forward(toAsync([])))
    expect(result).toHaveLength(0)
  })

  it('preserves message order for mixed data messages', async () => {
    const messages: Message[] = [record1, logMsg, state1, errorMsg, record2, streamStatus]
    const result = await drain(forward(toAsync(messages)))
    expect(result).toHaveLength(3)
    expect(result[0]).toBe(record1)
    expect(result[1]).toBe(state1)
    expect(result[2]).toBe(record2)
  })
})

// ---------------------------------------------------------------------------
// Tests: collect()
// ---------------------------------------------------------------------------

describe('collect()', () => {
  it('yields StateMessage', async () => {
    const output: DestinationOutput[] = [state1]
    const result = await drain(collect(toAsync(output)))
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(state1)
  })

  it('routes LogMessage to onLog callback', async () => {
    const onLog = vi.fn()
    const output: DestinationOutput[] = [logMsg]
    const result = await drain(collect(toAsync(output), { onLog }))
    expect(result).toHaveLength(0)
    expect(onLog).toHaveBeenCalledOnce()
    expect(onLog).toHaveBeenCalledWith('Sync started', 'info')
  })

  it('routes ErrorMessage to onError callback', async () => {
    const onError = vi.fn()
    const output: DestinationOutput[] = [errorMsg]
    const result = await drain(collect(toAsync(output), { onError }))
    expect(result).toHaveLength(0)
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith('Rate limited', 'transient_error')
  })

  it('handles empty stream', async () => {
    const result = await drain(collect(toAsync([])))
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: run()
// ---------------------------------------------------------------------------

describe('run()', () => {
  it('discovers catalog, reads source, writes destination, collects state', async () => {
    const messages: Message[] = [record1, state1, record2]
    const { source } = createMockSource(messages)
    const { destination, received } = createMockDestination()
    const sync = { ...stubSync, state: undefined }
    const orch = new PostgresOrchestrator(sync, stubStateManager)

    const checkpoints = await orch.run(source, destination)

    // Destination received records + state (log/error filtered by forward)
    expect(received).toHaveLength(3)
    expect(received[0]).toBe(record1)
    expect(received[1]).toBe(state1)
    expect(received[2]).toBe(record2)

    // collect() yielded the state message that destination re-emitted
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toBe(state1)
  })

  it('passes loaded state to source.read()', async () => {
    const sync: Sync = {
      ...stubSync,
      state: { customers: { cursor: '2024-06-01' } },
    }
    const messages: Message[] = [record1]
    const { source, readSpy } = createMockSource(messages)
    const { destination } = createMockDestination()
    const orch = new PostgresOrchestrator(sync, stubStateManager)

    await orch.run(source, destination)

    // source.read() was called with loaded state
    expect(readSpy).toHaveBeenCalledOnce()
    const { state: stateArg } = readSpy.mock.calls[0][0]
    expect(stateArg).toEqual({ customers: { cursor: '2024-06-01' } })
  })

  it('extracts streams from sync config against catalog', async () => {
    const multiCatalog: CatalogMessage = {
      type: 'catalog',
      streams: [
        { name: 'customers', primary_key: [['id']] },
        { name: 'invoices', primary_key: [['id']] },
        { name: 'products', primary_key: [['id']] },
      ],
    }
    const sync: Sync = {
      ...stubSync,
      streams: [{ name: 'customers' }, { name: 'invoices' }],
    }
    const { source, readSpy } = createMockSource([], multiCatalog)
    const { destination } = createMockDestination()
    const orch = new PostgresOrchestrator(sync, stubStateManager)

    await orch.run(source, destination)

    // source.read() was called with only the requested streams from catalog
    expect(readSpy).toHaveBeenCalledOnce()
    const { catalog: catalogArg } = readSpy.mock.calls[0][0]
    expect(catalogArg.streams).toHaveLength(2)
    expect(catalogArg.streams.map((s: { stream: { name: string } }) => s.stream.name)).toEqual([
      'customers',
      'invoices',
    ])
    // The streams include full catalog metadata (primary_key)
    expect(catalogArg.streams[0].stream.primary_key).toEqual([['id']])
  })

  it('uses all catalog streams when sync.streams is not set', async () => {
    const multiCatalog: CatalogMessage = {
      type: 'catalog',
      streams: [
        { name: 'customers', primary_key: [['id']] },
        { name: 'invoices', primary_key: [['id']] },
      ],
    }
    const sync: Sync = {
      ...stubSync,
      streams: undefined,
    }
    const { source, readSpy } = createMockSource([], multiCatalog)
    const { destination } = createMockDestination()
    const orch = new PostgresOrchestrator(sync, stubStateManager)

    await orch.run(source, destination)

    const { catalog: catalogArg } = readSpy.mock.calls[0][0]
    expect(catalogArg.streams).toHaveLength(2)
    expect(catalogArg.streams.map((s: { stream: { name: string } }) => s.stream.name)).toEqual([
      'customers',
      'invoices',
    ])
  })

  it('handles empty source (no messages)', async () => {
    const { source } = createMockSource([])
    const { destination, received } = createMockDestination()
    const orch = new PostgresOrchestrator({ ...stubSync }, stubStateManager)

    const checkpoints = await orch.run(source, destination)

    expect(received).toHaveLength(0)
    expect(checkpoints).toHaveLength(0)
  })

  it('persists state checkpoints to Sync.state', async () => {
    const state2: StateMessage = {
      type: 'state',
      stream: 'invoices',
      data: { cursor: '2024-12-31' },
    }
    const messages: Message[] = [record1, state1, state2]
    const { source } = createMockSource(messages)
    const { destination } = createMockDestination()
    const sync: Sync = { ...stubSync, state: undefined }
    const orch = new PostgresOrchestrator(sync, stubStateManager)

    await orch.run(source, destination)

    // Sync.state was updated with both checkpoints
    expect(sync.state).toEqual({
      customers: { cursor: '2024-01-01' },
      invoices: { cursor: '2024-12-31' },
    })
  })

  it('stops gracefully when stop() is called', async () => {
    // Create a source that yields messages slowly so we can stop mid-stream
    let yieldCount = 0
    const slowSource: Source = {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' as const }),
      async discover(_params: { config: Record<string, unknown> }): Promise<CatalogMessage> {
        return catalogMsg
      },
      async *read(_params: {
        config: Record<string, unknown>
        catalog: ConfiguredCatalog
        state?: Record<string, unknown>
      }): AsyncIterable<Message> {
        for (let i = 0; i < 100; i++) {
          yieldCount++
          yield {
            type: 'state',
            stream: 'customers',
            data: { cursor: `page_${i}` },
          } as StateMessage
        }
      },
    }
    const { destination } = createMockDestination()
    const orch = new PostgresOrchestrator({ ...stubSync }, stubStateManager)

    // Stop after first checkpoint is collected
    const originalCollect = orch.collect.bind(orch)
    let collected = 0
    orch.collect = function (output) {
      const iter = originalCollect(output)
      return {
        [Symbol.asyncIterator]() {
          return this
        },
        async next() {
          const result = await iter.next()
          if (!result.done) {
            collected++
            if (collected >= 2) {
              await orch.stop()
            }
          }
          return result
        },
        async return(value?: StateMessage) {
          return iter.return?.(value!) ?? { done: true as const, value: undefined }
        },
        async throw(e?: unknown) {
          return iter.throw?.(e) ?? { done: true as const, value: undefined }
        },
      }
    }

    const checkpoints = await orch.run(slowSource, destination)

    // Should have stopped early rather than processing all 100 messages
    expect(checkpoints.length).toBeGreaterThanOrEqual(1)
    expect(checkpoints.length).toBeLessThan(100)
  })

  it('loads state from multiple streams', async () => {
    const sync: Sync = {
      ...stubSync,
      state: {
        customers: { cursor: '2024-01-01' },
        invoices: { cursor: 'inv_50' },
      },
    }
    const { source, readSpy } = createMockSource([])
    const { destination } = createMockDestination()
    const orch = new PostgresOrchestrator(sync, stubStateManager)

    await orch.run(source, destination)

    const { state: stateArg } = readSpy.mock.calls[0][0]
    expect(stateArg).toEqual({
      customers: { cursor: '2024-01-01' },
      invoices: { cursor: 'inv_50' },
    })
  })

  it('passes undefined state when Sync.state is undefined', async () => {
    const sync: Sync = { ...stubSync, state: undefined }
    const { source, readSpy } = createMockSource([])
    const { destination } = createMockDestination()
    const orch = new PostgresOrchestrator(sync, stubStateManager)

    await orch.run(source, destination)

    const { state: stateArg } = readSpy.mock.calls[0][0]
    expect(stateArg).toBeUndefined()
  })

  it('filters non-data messages from reaching the destination', async () => {
    const messages: Message[] = [record1, logMsg, errorMsg, record2]
    const { source } = createMockSource(messages)
    const { destination, received } = createMockDestination()
    const orch = new PostgresOrchestrator({ ...stubSync }, stubStateManager)

    await orch.run(source, destination)

    // Only record messages reach the destination (log and error filtered by forward)
    expect(received).toHaveLength(2)
    expect(received[0]).toBe(record1)
    expect(received[1]).toBe(record2)
  })
})

// ---------------------------------------------------------------------------
// Tests: scenario stubs (pending implementation)
// ---------------------------------------------------------------------------

describe('persistence scenarios', () => {
  // Deferred: requires a SyncRepository / DB query layer that doesn't exist yet.
  // The orchestrator takes a pre-loaded Sync object in its constructor.
  // Loading from Postgres is infrastructure, not architecture. (Inc 35)
  it.todo('loads Sync config from Postgres on startup')
})

describe('forward() — status routing', () => {
  it('routes StreamStatusMessage to onStreamStatus callback', async () => {
    const onStreamStatus = vi.fn()
    const messages: Message[] = [record1, streamStatus, state1]
    const result = await drain(forward(toAsync(messages), { onStreamStatus }))

    // StreamStatusMessage is not yielded to the destination
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(record1)
    expect(result[1]).toBe(state1)

    // The callback was invoked with stream name and status
    expect(onStreamStatus).toHaveBeenCalledOnce()
    expect(onStreamStatus).toHaveBeenCalledWith('customers', 'running')
  })
})
