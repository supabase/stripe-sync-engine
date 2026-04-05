import type {
  CheckOutput,
  Destination,
  DiscoverOutput,
  Source,
  SpecOutput,
} from '@stripe/sync-protocol'
import {
  CatalogMessage,
  ConfiguredCatalog,
  ConfiguredStream,
  ConnectionStatusPayload,
  ConnectorSpecification,
  DestinationInput,
  DestinationOutput,
  LogMessage,
  Message,
  PipelineConfig,
  RecordMessage,
  StateMessage,
  Stream,
  TraceMessage,
} from '@stripe/sync-protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { destinationTest } from './destination-test.js'
import { createEngine } from './engine.js'
import type { ConnectorResolver } from './resolver.js'
import { sourceTest } from './source-test.js'
const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined)
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iter) {
    result.push(item)
  }
  return result
}

/** Re-iterable async iterable from an array — each `for await` gets a fresh iterator. */
function toAsync<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          if (i < items.length) return { value: items[i++], done: false as const }
          return { value: undefined, done: true as const }
        },
      }
    },
  }
}

function makeResolver(source: Source, destination: Destination): ConnectorResolver {
  return {
    resolveSource: async () => source,
    resolveDestination: async () => destination,
    sources: () => new Map(),
    destinations: () => new Map(),
  }
}

const defaultPipeline = {
  source: { type: 'test', test: {} },
  destination: { type: 'test', test: {} },
}

// ---------------------------------------------------------------------------
// Protocol schema tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  consoleInfo.mockClear()
  consoleError.mockClear()
})

describe('protocol schemas', () => {
  describe('Stream', () => {
    it('parses a valid stream', () => {
      const result = Stream.parse({ name: 'customers', primary_key: [['id']] })
      expect(result).toEqual({ name: 'customers', primary_key: [['id']] })
    })

    it('parses with optional fields', () => {
      const result = Stream.parse({
        name: 'users',
        primary_key: [['id']],
        json_schema: { type: 'object' },
        metadata: { account_id: 'acct_123' },
      })
      expect(result.json_schema).toEqual({ type: 'object' })
      expect(result.metadata).toEqual({ account_id: 'acct_123' })
    })

    it('rejects missing name', () => {
      expect(() => Stream.parse({ primary_key: [['id']] })).toThrow()
    })

    it('rejects missing primary_key', () => {
      expect(() => Stream.parse({ name: 'test' })).toThrow()
    })
  })

  describe('ConfiguredStream', () => {
    it('parses a valid configured stream', () => {
      const result = ConfiguredStream.parse({
        stream: { name: 'customers', primary_key: [['id']] },
        sync_mode: 'incremental',
        destination_sync_mode: 'append_dedup',
        cursor_field: ['updated_at'],
      })
      expect(result.sync_mode).toBe('incremental')
      expect(result.destination_sync_mode).toBe('append_dedup')
    })

    it('rejects invalid sync_mode', () => {
      expect(() =>
        ConfiguredStream.parse({
          stream: { name: 'test', primary_key: [['id']] },
          sync_mode: 'invalid',
          destination_sync_mode: 'append',
        })
      ).toThrow()
    })
  })

  describe('ConfiguredCatalog', () => {
    it('parses a valid catalog', () => {
      const result = ConfiguredCatalog.parse({
        streams: [
          {
            stream: { name: 'customers', primary_key: [['id']] },
            sync_mode: 'full_refresh',
            destination_sync_mode: 'overwrite',
          },
        ],
      })
      expect(result.streams).toHaveLength(1)
    })
  })

  describe('ConnectorSpecification', () => {
    it('parses with only config', () => {
      const result = ConnectorSpecification.parse({ config: { type: 'object' } })
      expect(result.config).toEqual({ type: 'object' })
    })

    it('parses with all fields', () => {
      const result = ConnectorSpecification.parse({
        config: {},
        stream_state: { type: 'object' },
        input: { type: 'object' },
      })
      expect(result.stream_state).toEqual({ type: 'object' })
      expect(result.input).toEqual({ type: 'object' })
    })
  })

  describe('ConnectionStatusPayload', () => {
    it('parses succeeded', () => {
      expect(ConnectionStatusPayload.parse({ status: 'succeeded' })).toEqual({
        status: 'succeeded',
      })
    })

    it('parses failed with message', () => {
      expect(ConnectionStatusPayload.parse({ status: 'failed', message: 'bad creds' })).toEqual({
        status: 'failed',
        message: 'bad creds',
      })
    })

    it('rejects invalid status', () => {
      expect(() => ConnectionStatusPayload.parse({ status: 'unknown' })).toThrow()
    })
  })

  describe('messages', () => {
    it('RecordMessage', () => {
      const msg = RecordMessage.parse({
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      })
      expect(msg.type).toBe('record')
      expect(msg.record.data).toEqual({ id: 'cus_1' })
    })

    it('StateMessage', () => {
      const msg = StateMessage.parse({
        type: 'state',
        state: {
          stream: 'customers',
          data: { cursor: 'abc' },
        },
      })
      expect(msg.type).toBe('state')
    })

    it('CatalogMessage', () => {
      const msg = CatalogMessage.parse({
        type: 'catalog',
        catalog: {
          streams: [{ name: 'users', primary_key: [['id']] }],
        },
      })
      expect(msg.catalog.streams).toHaveLength(1)
    })

    it('LogMessage', () => {
      const msg = LogMessage.parse({
        type: 'log',
        log: { level: 'info', message: 'hello' },
      })
      expect(msg.log.level).toBe('info')
    })

    it('TraceMessage (error)', () => {
      const msg = TraceMessage.parse({
        type: 'trace',
        trace: {
          trace_type: 'error',
          error: {
            failure_type: 'transient_error',
            message: 'retry',
            stream: 'customers',
            stack_trace: 'Error at ...',
          },
        },
      })
      expect(msg.trace.trace_type).toBe('error')
      if (msg.trace.trace_type === 'error') {
        expect(msg.trace.error.failure_type).toBe('transient_error')
        expect(msg.trace.error.stream).toBe('customers')
      }
    })

    it('TraceMessage (stream_status)', () => {
      const msg = TraceMessage.parse({
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: {
            stream: 'customers',
            status: 'running',
          },
        },
      })
      expect(msg.trace.trace_type).toBe('stream_status')
    })

    it('rejects missing type', () => {
      expect(() =>
        RecordMessage.parse({
          record: { stream: 'x', data: {}, emitted_at: '2024-01-01T00:00:00.000Z' },
        })
      ).toThrow()
    })

    it('rejects wrong type literal', () => {
      expect(() =>
        RecordMessage.parse({
          type: 'state',
          record: {
            stream: 'x',
            data: {},
            emitted_at: '2024-01-01T00:00:00.000Z',
          },
        })
      ).toThrow()
    })
  })

  describe('Message discriminated union', () => {
    it('parses all message types', () => {
      const messages = [
        {
          type: 'record',
          record: { stream: 's', data: {}, emitted_at: '2024-01-01T00:00:00.000Z' },
        },
        { type: 'state', state: { stream: 's', data: null } },
        { type: 'catalog', catalog: { streams: [{ name: 's', primary_key: [['id']] }] } },
        { type: 'log', log: { level: 'info', message: 'hi' } },
        {
          type: 'trace',
          trace: {
            trace_type: 'error',
            error: { failure_type: 'system_error', message: 'bad' },
          },
        },
        {
          type: 'trace',
          trace: {
            trace_type: 'stream_status',
            stream_status: { stream: 's', status: 'complete' },
          },
        },
      ]
      for (const msg of messages) {
        expect(() => Message.parse(msg)).not.toThrow()
      }
    })

    it('rejects unknown type', () => {
      expect(() => Message.parse({ type: 'unknown', data: {} })).toThrow()
    })
  })

  describe('DestinationInput', () => {
    it('accepts record and state', () => {
      expect(() =>
        DestinationInput.parse({
          type: 'record',
          record: {
            stream: 's',
            data: {},
            emitted_at: '2024-01-01T00:00:00.000Z',
          },
        })
      ).not.toThrow()
      expect(() =>
        DestinationInput.parse({ type: 'state', state: { stream: 's', data: null } })
      ).not.toThrow()
    })

    it('rejects log message', () => {
      expect(() =>
        DestinationInput.parse({ type: 'log', log: { level: 'info', message: 'hi' } })
      ).toThrow()
    })
  })

  describe('DestinationOutput', () => {
    it('accepts state, trace, and log', () => {
      expect(() =>
        DestinationOutput.parse({ type: 'state', state: { stream: 's', data: null } })
      ).not.toThrow()
      expect(() =>
        DestinationOutput.parse({
          type: 'trace',
          trace: {
            trace_type: 'error',
            error: { failure_type: 'system_error', message: 'x' },
          },
        })
      ).not.toThrow()
      expect(() =>
        DestinationOutput.parse({ type: 'log', log: { level: 'warn', message: 'x' } })
      ).not.toThrow()
    })

    it('rejects record message', () => {
      expect(() =>
        DestinationOutput.parse({
          type: 'record',
          record: {
            stream: 's',
            data: {},
            emitted_at: '2024-01-01T00:00:00.000Z',
          },
        })
      ).toThrow()
    })
  })

  describe('PipelineConfig', () => {
    it('parses minimal params', () => {
      const result = PipelineConfig.parse({
        source: { type: 'stripe' },
        destination: { type: 'postgres' },
      })
      expect(result.source).toEqual({ type: 'stripe' })
      expect(result.destination).toEqual({ type: 'postgres' })
    })

    it('parses with all fields', () => {
      const result = PipelineConfig.parse({
        source: { type: 'stripe', stripe: { api_key: 'sk_test' } },
        destination: { type: 'postgres', postgres: { url: 'pg://...' } },
        streams: [{ name: 'customers', sync_mode: 'incremental' }],
      })
      expect(result.streams).toHaveLength(1)
    })

    it('rejects missing source', () => {
      expect(() => PipelineConfig.parse({ destination: { type: 'postgres' } })).toThrow()
    })

    it('rejects missing destination', () => {
      expect(() => PipelineConfig.parse({ source: { type: 'stripe' } })).toThrow()
    })
  })
})

// ---------------------------------------------------------------------------
// Config validation tests
// ---------------------------------------------------------------------------

describe('engine config validation', () => {
  it('creates engine with valid configs', async () => {
    const engine = await createEngine(makeResolver(sourceTest, destinationTest))
    expect(engine).toBeDefined()
    expect(typeof engine.pipeline_read).toBe('function')
    expect(typeof engine.pipeline_write).toBe('function')
    expect(typeof engine.pipeline_sync).toBe('function')
    expect(typeof engine.meta_sources_list).toBe('function')
    expect(typeof engine.meta_destinations_list).toBe('function')
  })

  it('throws on invalid source config', async () => {
    const source: Source = {
      async *spec(): AsyncIterable<SpecOutput> {
        yield {
          type: 'spec',
          spec: { config: z.toJSONSchema(z.object({ api_key: z.string() })) },
        }
      },
      async *check(): AsyncIterable<CheckOutput> {
        yield { type: 'connection_status', connection_status: { status: 'succeeded' } }
      },
      async *discover(): AsyncIterable<DiscoverOutput> {
        yield { type: 'catalog', catalog: { streams: [] } }
      },
      async *read() {},
    }
    const pipeline = { source: { type: 'test', test: {} }, destination: { type: 'test', test: {} } }
    const engine = await createEngine(makeResolver(source, destinationTest))
    await expect(drain(engine.pipeline_read(pipeline))).rejects.toThrow()
  })

  it('throws on invalid destination config', async () => {
    const destination: Destination = {
      async *spec(): AsyncIterable<SpecOutput> {
        yield {
          type: 'spec',
          spec: { config: z.toJSONSchema(z.object({ url: z.string() })) },
        }
      },
      async *check(): AsyncIterable<CheckOutput> {
        yield { type: 'connection_status', connection_status: { status: 'succeeded' } }
      },
      *write(_params, $stdin) {
        ;(async () => {
          for await (const _ of $stdin) {
            /* drain */
          }
        })()
      },
    }
    const pipeline = {
      source: { type: 'test', test: { streams: {} } },
      destination: { type: 'test', test: {} },
    }
    const engine = await createEngine(makeResolver(sourceTest, destination))
    await expect(drain(engine.pipeline_write(pipeline, toAsync([])))).rejects.toThrow()
  })

  it('applies defaults from connector spec', async () => {
    const source: Source = {
      async *spec(): AsyncIterable<SpecOutput> {
        yield {
          type: 'spec',
          spec: { config: z.toJSONSchema(z.object({ schema: z.string().default('stripe') })) },
        }
      },
      async *check(): AsyncIterable<CheckOutput> {
        yield { type: 'connection_status', connection_status: { status: 'succeeded' } }
      },
      async *discover({ config }): AsyncIterable<DiscoverOutput> {
        // The engine should pass config with defaults applied
        expect(config).toEqual({ schema: 'stripe' })
        yield { type: 'catalog', catalog: { streams: [] } }
      },
      async *read() {},
    }

    const pipeline = { source: { type: 'test', test: {} }, destination: { type: 'test', test: {} } }
    const engine = await createEngine(makeResolver(source, destinationTest))
    return drain(engine.pipeline_sync(pipeline))
  })

  it('fromJSONSchema({}).parse(anything) works — backward compat with mock specs', () => {
    const schema = z.fromJSONSchema({})
    expect(schema.parse({ any: 'thing' })).toEqual({ any: 'thing' })
    expect(schema.parse(42)).toBe(42)
    expect(schema.parse('hello')).toBe('hello')
    expect(schema.parse(null)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Message validation in pipeline tests
// ---------------------------------------------------------------------------

describe('engine message validation', () => {
  it('valid messages pass through engine.pipeline_read()', async () => {
    const engine = await createEngine(makeResolver(sourceTest, destinationTest))
    const pipeline = {
      source: { type: 'test', test: { streams: { customers: {} } } },
      destination: { type: 'test', test: {} },
    }

    const results = await drain(
      engine.pipeline_read(
        pipeline,
        undefined,
        toAsync([
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_1' },
              emitted_at: new Date().toISOString(),
            },
          },
          { type: 'state', state: { stream: 'customers', data: { status: 'complete' } } },
        ])
      )
    )
    expect(results).toHaveLength(3)
    expect(results[0]!.type).toBe('record')
    expect(results[1]!.type).toBe('state')
    expect(results[2]).toMatchObject({ type: 'eof', eof: { reason: 'complete' } })
  })

  it('malformed source message throws', async () => {
    const badSource: Source = {
      async *spec(): AsyncIterable<SpecOutput> {
        yield { type: 'spec', spec: { config: {} } }
      },
      async *check(): AsyncIterable<CheckOutput> {
        yield { type: 'connection_status', connection_status: { status: 'succeeded' } }
      },
      async *discover(): AsyncIterable<DiscoverOutput> {
        yield {
          type: 'catalog',
          catalog: {
            streams: [{ name: 'customers', primary_key: [['id']] }],
          },
        }
      },
      async *read() {
        // Missing required fields — not a valid Message
        yield { type: 'record', stream: 'customers' } as unknown as Message
      },
    }
    const engine = await createEngine(makeResolver(badSource, destinationTest))

    await expect(drain(engine.pipeline_read(defaultPipeline))).rejects.toThrow()
  })

  it('destination output validation catches malformed messages', async () => {
    const badDest: Destination = {
      async *spec(): AsyncIterable<SpecOutput> {
        yield { type: 'spec', spec: { config: {} } }
      },
      async *check(): AsyncIterable<CheckOutput> {
        yield { type: 'connection_status', connection_status: { status: 'succeeded' } }
      },
      async *write(_params, $stdin) {
        for await (const _ of $stdin) {
          /* drain */
        }
        // Yield a malformed message
        yield { type: 'bad' } as unknown as DestinationOutput
      },
    }

    const pipeline = {
      source: { type: 'test', test: { streams: { customers: {} } } },
      destination: { type: 'test', test: {} },
    }
    const engine = await createEngine(makeResolver(sourceTest, badDest))

    await expect(
      drain(
        engine.pipeline_sync(
          pipeline,
          undefined,
          toAsync([
            {
              type: 'record',
              record: {
                stream: 'customers',
                data: { id: 'cus_1' },
                emitted_at: new Date().toISOString(),
              },
            },
            { type: 'state', state: { stream: 'customers', data: { status: 'complete' } } },
          ])
        )
      )
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Stream membership validation tests
// ---------------------------------------------------------------------------

describe('engine stream membership validation', () => {
  it('record with known stream passes through', async () => {
    const engine = await createEngine(makeResolver(sourceTest, destinationTest))
    const pipeline = {
      source: { type: 'test', test: { streams: { customers: {} } } },
      destination: { type: 'test', test: {} },
    }

    const results = await drain(
      engine.pipeline_read(
        pipeline,
        undefined,
        toAsync([
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_1' },
              emitted_at: new Date().toISOString(),
            },
          },
          { type: 'state', state: { stream: 'customers', data: { status: 'complete' } } },
        ])
      )
    )
    expect(results.filter((m) => m.type === 'record')).toHaveLength(1)
  })

  it('non-stream messages pass through regardless of stream field', async () => {
    // Source that emits log + trace error messages (which don't require stream membership)
    const source: Source = {
      async *spec(): AsyncIterable<SpecOutput> {
        yield { type: 'spec', spec: { config: {} } }
      },
      async *check(): AsyncIterable<CheckOutput> {
        yield { type: 'connection_status', connection_status: { status: 'succeeded' } }
      },
      async *discover(): AsyncIterable<DiscoverOutput> {
        yield {
          type: 'catalog',
          catalog: {
            streams: [{ name: 'customers', primary_key: [['id']] }],
          },
        }
      },
      async *read() {
        yield { type: 'log' as const, log: { level: 'info' as const, message: 'hello' } }
        yield {
          type: 'trace' as const,
          trace: {
            trace_type: 'error' as const,
            error: {
              failure_type: 'system_error' as const,
              message: 'oops',
              stream: 'nonexistent',
            },
          },
        }
      },
    }
    const engine = await createEngine(makeResolver(source, destinationTest))

    const results = await drain(engine.pipeline_read(defaultPipeline))
    expect(results).toHaveLength(3)
    expect(results[0]!.type).toBe('log')
    expect(results[1]!.type).toBe('trace')
    expect(results[2]).toMatchObject({ type: 'eof', eof: { reason: 'complete' } })
  })
})

// ---------------------------------------------------------------------------
// engine.pipeline_sync() pipeline tests
// ---------------------------------------------------------------------------

describe('engine.pipeline_sync() pipeline', () => {
  it('basic pipeline: yields state messages from source → destination', async () => {
    const engine = await createEngine(makeResolver(sourceTest, destinationTest))
    const pipeline = {
      source: { type: 'test', test: { streams: { customers: {} } } },
      destination: { type: 'test', test: {} },
    }
    const results = await drain(
      engine.pipeline_sync(
        pipeline,
        undefined,
        toAsync([
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_1', name: 'Alice' },
              emitted_at: new Date().toISOString(),
            },
          },
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_2', name: 'Bob' },
              emitted_at: new Date().toISOString(),
            },
          },
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_3', name: 'Charlie' },
              emitted_at: new Date().toISOString(),
            },
          },
          { type: 'state', state: { stream: 'customers', data: { status: 'complete' } } },
        ])
      )
    )

    // pipeline_sync now yields source signals alongside dest output — filter to state+eof
    const stateAndEof = results.filter((m) => m.type === 'state' || m.type === 'eof')
    expect(stateAndEof).toHaveLength(2)
    expect(stateAndEof[0]).toMatchObject({
      type: 'state',
      state: { stream: 'customers', data: { status: 'complete' } },
    })
    expect(stateAndEof[1]).toMatchObject({ type: 'eof', eof: { reason: 'complete' } })
  })

  it('stream filtering: only configures requested streams', async () => {
    const engine = await createEngine(makeResolver(sourceTest, destinationTest))
    const pipeline = {
      source: { type: 'test', test: { streams: { customers: {}, invoices: {} } } },
      destination: { type: 'test', test: {} },
      streams: [{ name: 'customers' }],
    }
    const results = await drain(
      engine.pipeline_sync(
        pipeline,
        undefined,
        toAsync([
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_1' },
              emitted_at: new Date().toISOString(),
            },
          },
          { type: 'state', state: { stream: 'customers', data: { status: 'complete' } } },
          {
            type: 'record',
            record: {
              stream: 'invoices',
              data: { id: 'inv_1' },
              emitted_at: new Date().toISOString(),
            },
          },
          { type: 'state', state: { stream: 'invoices', data: { status: 'complete' } } },
        ])
      )
    )

    // Only the customers stream state should come through
    const states = results.filter((r) => r.type === 'state')
    expect(states).toHaveLength(1)
    expect((states[0] as StateMessage).state.stream).toBe('customers')
  })

  it('non-data messages filtered: only record + state reach destination', async () => {
    // Source that emits log, trace error, trace stream_status, record, and state —
    // only record + state should reach the destination (non-data messages are routed to callbacks)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const mixedSource: Source = {
      async *spec(): AsyncIterable<SpecOutput> {
        yield { type: 'spec', spec: { config: {} } }
      },
      async *check(): AsyncIterable<CheckOutput> {
        yield { type: 'connection_status', connection_status: { status: 'succeeded' } }
      },
      async *discover(): AsyncIterable<DiscoverOutput> {
        yield {
          type: 'catalog',
          catalog: {
            streams: [{ name: 'customers', primary_key: [['id']] }],
          },
        }
      },
      async *read() {
        yield { type: 'log' as const, log: { level: 'info' as const, message: 'starting' } }
        yield {
          type: 'trace' as const,
          trace: {
            trace_type: 'error' as const,
            error: {
              failure_type: 'transient_error' as const,
              message: 'rate limited',
            },
          },
        }
        yield {
          type: 'trace' as const,
          trace: {
            trace_type: 'stream_status' as const,
            stream_status: {
              stream: 'customers',
              status: 'running' as const,
            },
          },
        }
        yield {
          type: 'record' as const,
          record: {
            stream: 'customers',
            data: { id: 'cus_1' },
            emitted_at: '2024-01-01T00:00:00.000Z',
          },
        }
        yield {
          type: 'state' as const,
          state: {
            stream: 'customers',
            data: { after: 'cus_1' },
          },
        }
      },
    }

    const engine = await createEngine(makeResolver(mixedSource, destinationTest))
    const results = await drain(engine.pipeline_sync(defaultPipeline))

    // pipeline_sync now yields source signals (log/trace) alongside dest output
    // Filter to state+eof to verify destination processing
    const stateAndEof = results.filter((m) => m.type === 'state' || m.type === 'eof')
    expect(stateAndEof).toHaveLength(2)
    expect(stateAndEof[0]!.type).toBe('state')
    expect(stateAndEof[1]).toMatchObject({ type: 'eof', eof: { reason: 'complete' } })
    // Source signals (log, trace) are also present in the output
    const sourceSignals = results.filter((m) => m.type === 'log' || m.type === 'trace')
    expect(sourceSignals.length).toBeGreaterThan(0)

    vi.restoreAllMocks()
  })
})
