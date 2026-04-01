import { describe, expect, it } from 'vitest'
import type {
  Destination,
  ConfiguredCatalog,
  DestinationInput,
  DestinationOutput,
} from '@stripe/sync-protocol'
import { withCatalogFilter } from './destination-filter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iter) result.push(item)
  return result
}

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

function makeCatalog(
  streams: Array<{
    name: string
    fields?: string[]
    json_schema?: Record<string, unknown>
  }>
): ConfiguredCatalog {
  return {
    streams: streams.map((s) => ({
      stream: { name: s.name, primary_key: [['id']], json_schema: s.json_schema },
      sync_mode: 'full_refresh' as const,
      destination_sync_mode: 'append' as const,
      fields: s.fields,
    })),
  }
}

/**
 * Create a mock destination that captures the catalog passed to setup() and write().
 */
function capturingDestination() {
  const captured: { setup?: ConfiguredCatalog; write?: ConfiguredCatalog } = {}

  const dest: Destination = {
    spec: () => ({ config: {} }),
    check: async () => ({ status: 'succeeded' }),
    async setup({ catalog }) {
      captured.setup = catalog
    },
    async *write({ catalog }, $stdin) {
      captured.write = catalog
      for await (const msg of $stdin) {
        if (msg.type === 'state') yield msg
      }
    },
  }

  return { dest, captured }
}

// ---------------------------------------------------------------------------
// withCatalogFilter()
// ---------------------------------------------------------------------------

describe('withCatalogFilter()', () => {
  it('prunes json_schema.properties in setup() to selected fields plus primary key', async () => {
    const { dest, captured } = capturingDestination()
    const wrapped = withCatalogFilter(dest)

    const catalog = makeCatalog([
      {
        name: 'customers',
        fields: ['name', 'email'],
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
          },
        },
      },
    ])

    await wrapped.setup!({ config: {}, catalog })

    const props = captured.setup!.streams[0]!.stream.json_schema!.properties as Record<
      string,
      unknown
    >
    expect(Object.keys(props)).toEqual(['id', 'name', 'email'])
  })

  it('prunes json_schema.properties in write() to selected fields plus primary key', async () => {
    const { dest, captured } = capturingDestination()
    const wrapped = withCatalogFilter(dest)

    const catalog = makeCatalog([
      {
        name: 'invoices',
        fields: ['amount', 'currency'],
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            amount: { type: 'integer' },
            currency: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    ])

    const input: DestinationInput[] = [{ type: 'state', stream: 'invoices', data: { cursor: '1' } }]
    await drain(wrapped.write({ config: {}, catalog }, toAsync(input)))

    const props = captured.write!.streams[0]!.stream.json_schema!.properties as Record<
      string,
      unknown
    >
    expect(Object.keys(props)).toEqual(['id', 'amount', 'currency'])
  })

  it('passes catalog through unchanged when no fields configured', async () => {
    const { dest, captured } = capturingDestination()
    const wrapped = withCatalogFilter(dest)

    const catalog = makeCatalog([
      {
        name: 'products',
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            active: { type: 'boolean' },
          },
        },
      },
    ])

    await wrapped.setup!({ config: {}, catalog })

    const props = captured.setup!.streams[0]!.stream.json_schema!.properties as Record<
      string,
      unknown
    >
    expect(Object.keys(props)).toEqual(['id', 'name', 'active'])
  })

  it('passes stream through unchanged when json_schema is absent', async () => {
    const { dest, captured } = capturingDestination()
    const wrapped = withCatalogFilter(dest)

    const catalog = makeCatalog([{ name: 'events', fields: ['id', 'type'] }])

    await wrapped.setup!({ config: {}, catalog })

    expect(captured.setup!.streams[0]!.stream.json_schema).toBeUndefined()
  })

  it('handles mixed streams: filters only those with fields set', async () => {
    const { dest, captured } = capturingDestination()
    const wrapped = withCatalogFilter(dest)

    const catalog = makeCatalog([
      {
        name: 'customers',
        fields: ['email'],
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
          },
        },
      },
      {
        name: 'products',
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
    ])

    await wrapped.setup!({ config: {}, catalog })

    const customerProps = captured.setup!.streams[0]!.stream.json_schema!.properties as Record<
      string,
      unknown
    >
    expect(Object.keys(customerProps)).toEqual(['id', 'email'])

    const productProps = captured.setup!.streams[1]!.stream.json_schema!.properties as Record<
      string,
      unknown
    >
    expect(Object.keys(productProps)).toEqual(['id', 'name'])
  })

  it('omits setup when underlying destination has no setup', () => {
    const dest: Destination = {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' }),
      async *write(_params, $stdin) {
        for await (const msg of $stdin) {
          if (msg.type === 'state') yield msg
        }
      },
    }

    const wrapped = withCatalogFilter(dest)
    expect(wrapped.setup).toBeUndefined()
  })

  it('delegates spec() unchanged', () => {
    const spec = { config: { type: 'object', properties: { url: { type: 'string' } } } }
    const dest: Destination = {
      spec: () => spec,
      check: async () => ({ status: 'succeeded' }),
      async *write(_params, $stdin) {
        for await (const _ of $stdin) {
          /* drain */
        }
      },
    }

    const wrapped = withCatalogFilter(dest)
    expect(wrapped.spec()).toBe(spec)
  })

  it('delegates check() unchanged', async () => {
    const dest: Destination = {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'failed', message: 'bad creds' }),
      async *write(_params, $stdin) {
        for await (const _ of $stdin) {
          /* drain */
        }
      },
    }

    const wrapped = withCatalogFilter(dest)
    const result = await wrapped.check({ config: {} })
    expect(result).toEqual({ status: 'failed', message: 'bad creds' })
  })

  it('delegates teardown() unchanged', async () => {
    let teardownCalled = false
    const dest: Destination = {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' }),
      async *write(_params, $stdin) {
        for await (const _ of $stdin) {
          /* drain */
        }
      },
      async teardown() {
        teardownCalled = true
      },
    }

    const wrapped = withCatalogFilter(dest)
    await wrapped.teardown!({ config: {} })
    expect(teardownCalled).toBe(true)
  })
})
