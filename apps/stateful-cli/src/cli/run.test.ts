import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type {
  ConnectorResolver,
  Destination,
  DestinationInput,
  DestinationOutput,
  ConfiguredCatalog,
  Message,
  Source,
  StateMessage,
} from '@stripe/sync-engine-stateless-cli'
import { runSync } from './run'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item
  }
}

function mockResolver(source: Source, destination: Destination): ConnectorResolver {
  return {
    resolveSource: async () => source,
    resolveDestination: async () => destination,
  }
}

function createMockSource(messages: Message[]): Source {
  return {
    spec: () => ({ config: {} }),
    check: async () => ({ status: 'succeeded' as const }),
    discover: async () => ({
      type: 'catalog',
      streams: [{ name: 'customers', primary_key: [['id']] }],
    }),
    read: () => toAsync(messages),
    setup: async () => {},
    teardown: async () => {},
  }
}

function createMockDestination(): { destination: Destination; received: DestinationInput[] } {
  const received: DestinationInput[] = []
  return {
    destination: {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' as const }),
      write: (
        _params: { config: Record<string, unknown>; catalog: ConfiguredCatalog },
        $stdin: AsyncIterable<DestinationInput>
      ): AsyncIterable<DestinationOutput> =>
        (async function* () {
          for await (const msg of $stdin) {
            received.push(msg)
            if (msg.type === 'state') yield msg
          }
        })(),
      setup: async () => {},
      teardown: async () => {},
    },
    received,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedEnv = {
    STRIPE_API_KEY: process.env.STRIPE_API_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
  }
  process.env.STRIPE_API_KEY = 'sk_test_fake'
  process.env.DATABASE_URL = 'postgresql://localhost/test'
})

afterEach(() => {
  process.env.STRIPE_API_KEY = savedEnv.STRIPE_API_KEY
  process.env.DATABASE_URL = savedEnv.DATABASE_URL
})

describe('runSync', () => {
  it('yields state messages from a successful sync', async () => {
    const record: Message = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_1', name: 'Alice' },
      emitted_at: 1000,
    }
    const stateMsg: StateMessage = {
      type: 'state',
      stream: 'customers',
      data: { cursor: 'cus_1' },
    }
    const source = createMockSource([record, stateMsg])
    const { destination } = createMockDestination()

    const messages: StateMessage[] = []
    for await (const msg of runSync({
      syncId: 'test_sync',
      sourceType: 'stripe',
      destinationType: 'postgres',
      connectors: mockResolver(source, destination),
    })) {
      messages.push(msg)
    }

    expect(messages).toHaveLength(1)
    expect(messages[0]!.type).toBe('state')
    expect(messages[0]!.stream).toBe('customers')
    expect(messages[0]!.data).toEqual({ cursor: 'cus_1' })
  })

  it('yields no state messages when source emits only records', async () => {
    const record: Message = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_1' },
      emitted_at: 1000,
    }
    const source = createMockSource([record])
    const { destination } = createMockDestination()

    const messages: StateMessage[] = []
    for await (const msg of runSync({
      syncId: 'test_sync',
      sourceType: 'stripe',
      destinationType: 'postgres',
      connectors: mockResolver(source, destination),
    })) {
      messages.push(msg)
    }

    expect(messages).toHaveLength(0)
  })

  it('destination receives all records and state messages', async () => {
    const record: Message = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_1' },
      emitted_at: 1000,
    }
    const stateMsg: StateMessage = {
      type: 'state',
      stream: 'customers',
      data: { cursor: 'cus_1' },
    }
    const source = createMockSource([record, stateMsg])
    const { destination, received } = createMockDestination()

    for await (const _msg of runSync({
      syncId: 'test_sync',
      sourceType: 'stripe',
      destinationType: 'postgres',
      connectors: mockResolver(source, destination),
    })) {
      // consume
    }

    expect(received).toHaveLength(2)
    expect(received[0]!.type).toBe('record')
    expect(received[1]!.type).toBe('state')
  })
})
