import { describe, expect, it, vi } from 'vitest'
import type {
  CatalogMessage,
  ConfiguredCatalog,
  ConnectorResolver,
  Destination,
  DestinationInput,
  DestinationOutput,
  Message,
  RecordMessage,
  Source,
  StateMessage,
} from '@stripe/sync-protocol'
import { createApp } from '../app'

/** Build a ConnectorResolver from mock source + destination. */
function mockResolver(source: Source, destination: Destination): ConnectorResolver {
  return {
    resolveSource: async () => source,
    resolveDestination: async () => destination,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item
  }
}

/** Read an SSE response body into an array of parsed data lines. */
async function readSse<T>(res: Response): Promise<T[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as T)
}

/** Build NDJSON string from array of objects. */
function toNdjson(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n')
}

const syncParams = JSON.stringify({
  source: 'stripe',
  destination: 'postgres',
  source_config: { api_key: 'sk_test' },
  destination_config: { url: 'pg://localhost/test' },
})

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
    (
      _params: {
        config: Record<string, unknown>
        catalog: ConfiguredCatalog
        state?: Record<string, unknown>
      },
      _$stdin?: AsyncIterable<unknown>
    ): AsyncIterable<Message> => toAsync(messages)
  )
  return {
    source: {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' as const }),
      discover: async () => discoverCatalog,
      read: readSpy,
      setup: vi.fn(async () => {}),
      teardown: vi.fn(async () => {}),
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
    (
      _params: { config: Record<string, unknown>; catalog: ConfiguredCatalog },
      $stdin: AsyncIterable<DestinationInput>
    ): AsyncIterable<DestinationOutput> => {
      return (async function* () {
        for await (const msg of $stdin) {
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
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' as const }),
      write: writeSpy,
      setup: vi.fn(async () => {}),
      teardown: vi.fn(async () => {}),
    },
    writeSpy,
    received,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /setup', () => {
  it('returns 204', async () => {
    const { source } = createMockSource([])
    const { destination } = createMockDestination()
    const app = createApp(mockResolver(source, destination))

    const res = await app.request('/setup', {
      method: 'POST',
      headers: { 'X-Sync-Params': syncParams },
    })
    expect(res.status).toBe(204)
  })
})

describe('POST /teardown', () => {
  it('returns 204', async () => {
    const { source } = createMockSource([])
    const { destination } = createMockDestination()
    const app = createApp(mockResolver(source, destination))

    const res = await app.request('/teardown', {
      method: 'POST',
      headers: { 'X-Sync-Params': syncParams },
    })
    expect(res.status).toBe(204)
  })
})

describe('GET /check', () => {
  it('returns source and destination check results', async () => {
    const { source } = createMockSource([])
    const { destination } = createMockDestination()
    const app = createApp(mockResolver(source, destination))

    const res = await app.request('/check', {
      headers: { 'X-Sync-Params': syncParams },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      source: { status: 'succeeded' },
      destination: { status: 'succeeded' },
    })
  })
})

describe('POST /read', () => {
  it('streams messages as SSE', async () => {
    const record: RecordMessage = {
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
    const { source } = createMockSource([record, stateMsg])
    const { destination } = createMockDestination()
    const app = createApp(mockResolver(source, destination))

    const res = await app.request('/read', {
      method: 'POST',
      headers: { 'X-Sync-Params': syncParams },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')

    const events = await readSse<Message>(res)
    expect(events).toHaveLength(2)
    expect(events[0]!.type).toBe('record')
    expect(events[1]!.type).toBe('state')
  })

  it('passes NDJSON body as input to source.read()', async () => {
    const record: RecordMessage = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_1' },
      emitted_at: 1000,
    }
    const { source, readSpy } = createMockSource([record])
    const { destination } = createMockDestination()
    const app = createApp(mockResolver(source, destination))

    const events = [{ type: 'webhook', data: { id: 'evt_1' } }]
    const res = await app.request('/read', {
      method: 'POST',
      headers: {
        'X-Sync-Params': syncParams,
        'Content-Type': 'application/x-ndjson',
      },
      body: toNdjson(events),
    })

    expect(res.status).toBe(200)
    await readSse(res)

    // source.read() should have been called with $stdin (second arg)
    expect(readSpy).toHaveBeenCalledOnce()
    const $stdin = readSpy.mock.calls[0]![1] as AsyncIterable<unknown>
    expect($stdin).toBeDefined()
    const items: unknown[] = []
    for await (const item of $stdin) items.push(item)
    expect(items).toEqual(events)
  })
})

describe('POST /write', () => {
  it('accepts NDJSON records, streams SSE state back', async () => {
    const { source } = createMockSource([])
    const { destination, received } = createMockDestination()
    const app = createApp(mockResolver(source, destination))

    const records: Message[] = [
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1' },
        emitted_at: 1000,
      },
      {
        type: 'state',
        stream: 'customers',
        data: { cursor: 'cus_1' },
      },
    ]

    const res = await app.request('/write', {
      method: 'POST',
      headers: {
        'X-Sync-Params': syncParams,
        'Content-Type': 'application/x-ndjson',
      },
      body: toNdjson(records),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')

    const events = await readSse<StateMessage>(res)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('state')
    expect(events[0]!.stream).toBe('customers')

    // Destination received the record + state
    expect(received).toHaveLength(2)
  })

  it('returns 400 when body is missing', async () => {
    const { source } = createMockSource([])
    const { destination } = createMockDestination()
    const app = createApp(mockResolver(source, destination))

    const res = await app.request('/write', {
      method: 'POST',
      headers: { 'X-Sync-Params': syncParams },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('body required')
  })
})

describe('POST /run', () => {
  it('runs full pipeline, streams SSE state', async () => {
    const record: RecordMessage = {
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
    const { source } = createMockSource([record, stateMsg])
    const { destination, received } = createMockDestination()
    const app = createApp(mockResolver(source, destination))

    const res = await app.request('/run', {
      method: 'POST',
      headers: { 'X-Sync-Params': syncParams },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')

    const events = await readSse<StateMessage>(res)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('state')

    // Destination received record + state
    expect(received).toHaveLength(2)
  })
})

describe('error handling', () => {
  it('returns 400 when X-Sync-Params header is missing', async () => {
    const { source } = createMockSource([])
    const { destination } = createMockDestination()
    const app = createApp(mockResolver(source, destination))

    const res = await app.request('/check')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Missing X-Sync-Params')
  })

  it('returns 400 when X-Sync-Params header is invalid JSON', async () => {
    const { source } = createMockSource([])
    const { destination } = createMockDestination()
    const app = createApp(mockResolver(source, destination))

    const res = await app.request('/check', {
      headers: { 'X-Sync-Params': 'not-json' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid JSON')
  })
})
