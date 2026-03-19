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
} from '../types'
import { runSync } from '../runSync'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* toAsync<T>(items: T[]): AsyncIterableIterator<T> {
  for (const item of items) {
    yield item
  }
}

async function drain<T>(iter: AsyncIterableIterator<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iter) {
    result.push(item)
  }
  return result
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

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
      state?: StateMessage[]
    }): AsyncIterableIterator<Message> => toAsync(messages)
  )
  return {
    source: {
      spec: () => ({ connection_specification: {} }),
      check: async () => ({ status: 'succeeded' as const }),
      discover: async () => discoverCatalog,
      read: readSpy,
    },
    readSpy,
  }
}

function createMockDestination(): {
  destination: Destination
  writeSpy: ReturnType<typeof vi.fn>
  received: DestinationInput[]
} {
  const received: DestinationInput[] = []
  const writeSpy = vi.fn(
    (params: {
      config: Record<string, unknown>
      catalog: ConfiguredCatalog
      messages: AsyncIterableIterator<DestinationInput>
    }): AsyncIterableIterator<DestinationOutput> => {
      // Pass through: drain inputs, collect them, yield back any StateMessages
      return (async function* () {
        for await (const msg of params.messages) {
          received.push(msg)
          if (msg.type === 'state') {
            yield msg
          }
        }
      })()
    }
  )
  return {
    destination: {
      spec: () => ({ connection_specification: {} }),
      check: async () => ({ status: 'succeeded' as const }),
      write: writeSpy,
    },
    writeSpy,
    received,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSync', () => {
  it('basic pipeline: yields state messages from source → destination', async () => {
    const record1: RecordMessage = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_1', name: 'Alice' },
      emitted_at: 1000,
    }
    const record2: RecordMessage = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_2', name: 'Bob' },
      emitted_at: 1001,
    }
    const record3: RecordMessage = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_3', name: 'Charlie' },
      emitted_at: 1002,
    }
    const stateMsg: StateMessage = {
      type: 'state',
      stream: 'customers',
      data: { after: 'cus_3' },
    }

    const { source } = createMockSource([record1, record2, record3, stateMsg])
    const { destination, received } = createMockDestination()

    const results = await drain(
      runSync(
        { source_config: { api_key: 'sk_test' }, destination_config: { url: 'pg://...' } },
        source,
        destination
      )
    )

    // Destination received all 3 records + 1 state
    expect(received).toHaveLength(4)
    expect(received.filter((m) => m.type === 'record')).toHaveLength(3)
    expect(received.filter((m) => m.type === 'state')).toHaveLength(1)

    // Pipeline yields 1 state message
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      type: 'state',
      stream: 'customers',
      data: { after: 'cus_3' },
    })
  })

  it('resume from state: passes state to source.read()', async () => {
    const { source, readSpy } = createMockSource([])
    const { destination } = createMockDestination()

    await drain(
      runSync(
        {
          source_config: {},
          destination_config: {},
          state: { customers: { after: 'cus_50' } },
        },
        source,
        destination
      )
    )

    expect(readSpy).toHaveBeenCalledOnce()
    const callArgs = readSpy.mock.calls[0]![0]
    expect(callArgs.state).toEqual([
      { type: 'state', stream: 'customers', data: { after: 'cus_50' } },
    ])
  })

  it('stream filtering: only configures requested streams', async () => {
    const { source } = createMockSource([], {
      type: 'catalog',
      streams: [
        { name: 'customers', primary_key: [['id']] },
        { name: 'invoices', primary_key: [['id']] },
      ],
    })
    const { destination, writeSpy } = createMockDestination()

    await drain(
      runSync(
        {
          source_config: {},
          destination_config: {},
          streams: [{ name: 'customers' }],
        },
        source,
        destination
      )
    )

    expect(writeSpy).toHaveBeenCalledOnce()
    const catalog: ConfiguredCatalog = writeSpy.mock.calls[0]![0].catalog
    expect(catalog.streams).toHaveLength(1)
    expect(catalog.streams[0]!.stream.name).toBe('customers')
  })

  it('non-data messages filtered: only record + state reach destination', async () => {
    const logMsg: LogMessage = { type: 'log', level: 'info', message: 'starting' }
    const errorMsg: ErrorMessage = {
      type: 'error',
      failure_type: 'transient_error',
      message: 'rate limited',
    }
    const statusMsg: StreamStatusMessage = {
      type: 'stream_status',
      stream: 'customers',
      status: 'running',
    }
    const record: RecordMessage = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_1' },
      emitted_at: 1000,
    }
    const stateMsg: StateMessage = {
      type: 'state',
      stream: 'customers',
      data: { after: 'cus_1' },
    }

    // Suppress stderr output during test
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const { source } = createMockSource([logMsg, errorMsg, statusMsg, record, stateMsg])
    const { destination, received } = createMockDestination()

    await drain(runSync({ source_config: {}, destination_config: {} }, source, destination))

    // Only record + state reach destination
    expect(received).toHaveLength(2)
    expect(received[0]!.type).toBe('record')
    expect(received[1]!.type).toBe('state')

    vi.restoreAllMocks()
  })
})
