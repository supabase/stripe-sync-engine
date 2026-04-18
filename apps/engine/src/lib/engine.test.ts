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
  SourceStateMessage,
  Stream,
  TraceMessage,
  withAbortOnReturn,
} from '@stripe/sync-protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { destinationTest } from './destination-test.js'
import { buildCatalog, createEngine, injectTimeRanges } from './engine.js'
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
        source_state_stream: { type: 'object' },
        source_input: { type: 'object' },
      })
      expect(result.source_state_stream).toEqual({ type: 'object' })
      expect(result.source_input).toEqual({ type: 'object' })
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

    it('SourceStateMessage', () => {
      const msg = SourceStateMessage.parse({
        type: 'source_state',
        source_state: {
          stream: 'customers',
          data: { cursor: 'abc' },
        },
      })
      expect(msg.type).toBe('source_state')
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
          type: 'source_state',
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
        { type: 'source_state', source_state: { stream: 's', data: null } },
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
        DestinationInput.parse({ type: 'source_state', source_state: { stream: 's', data: null } })
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
        DestinationOutput.parse({
          type: 'source_state',
          source_state: { stream: 's', data: null },
        })
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
          {
            type: 'source_state',
            source_state: { stream: 'customers', data: { status: 'complete' } },
          },
        ])
      )
    )
    expect(results).toHaveLength(3)
    expect(results[0]!.type).toBe('record')
    expect(results[1]!.type).toBe('source_state')
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
            {
              type: 'source_state',
              source_state: { stream: 'customers', data: { status: 'complete' } },
            },
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
          {
            type: 'source_state',
            source_state: { stream: 'customers', data: { status: 'complete' } },
          },
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
// engine.pipeline_read() input state validation
// ---------------------------------------------------------------------------

describe('engine.pipeline_read() input state validation', () => {
  const stateStreamSchema = {
    type: 'object',
    properties: {
      remaining: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            gte: { type: 'string' },
            lt: { type: 'string' },
            cursor: { type: ['string', 'null'] },
          },
          required: ['gte', 'lt', 'cursor'],
        },
      },
    },
    required: ['remaining'],
  }

  /** A source whose spec declares source_state_stream. */
  const sourceWithStateSchema: Source = {
    async *spec() {
      yield {
        type: 'spec' as const,
        spec: { config: {}, source_state_stream: stateStreamSchema },
      }
    },
    async *check() {
      yield {
        type: 'connection_status' as const,
        connection_status: { status: 'succeeded' as const },
      }
    },
    async *discover() {
      yield {
        type: 'catalog' as const,
        catalog: { streams: [{ name: 'customers', json_schema: {} }] },
      }
    },
    async *read() {
      yield {
        type: 'record' as const,
        record: { stream: 'customers', data: { id: '1' }, emitted_at: new Date().toISOString() },
      }
    },
  }

  it('rejects invalid input state when source declares source_state_stream', async () => {
    const engine = await createEngine(makeResolver(sourceWithStateSchema, destinationTest))
    const pipeline = {
      source: { type: 'test', test: { streams: { customers: {} } } },
      destination: { type: 'test', test: {} },
    }
    await expect(
      drain(
        engine.pipeline_read(pipeline, {
          state: { source: { streams: { customers: 'not-an-object' }, global: {} } },
        })
      )
    ).rejects.toThrow(/Invalid state for stream "customers"/)
  })

  it('accepts valid input state matching source_state_stream schema', async () => {
    const engine = await createEngine(makeResolver(sourceWithStateSchema, destinationTest))
    const pipeline = {
      source: { type: 'test', test: { streams: { customers: {} } } },
      destination: { type: 'test', test: {} },
    }
    const results = await drain(
      engine.pipeline_read(pipeline, {
        state: {
          source: {
            streams: {
              customers: { remaining: [{ gte: '2024-01-01', lt: '2025-01-01', cursor: null }] },
            },
            global: {},
          },
        },
      })
    )
    expect(results.length).toBeGreaterThan(0)
  })

  it('skips validation when source does not declare source_state_stream', async () => {
    const engine = await createEngine(makeResolver(sourceTest, destinationTest))
    const pipeline = {
      source: { type: 'test', test: { streams: { customers: {} } } },
      destination: { type: 'test', test: {} },
    }
    // Any state shape should be accepted
    const results = await drain(
      engine.pipeline_read(pipeline, {
        state: { source: { streams: { customers: { anything: 'goes' } }, global: {} } },
      })
    )
    expect(results.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// engine.pipeline_sync() pipeline tests
// ---------------------------------------------------------------------------

describe('engine.pipeline_sync() pipeline', () => {
  it('normalizes legacy section state for direct in-process callers', async () => {
    let receivedState: unknown
    const stateCapturingSource: Source = {
      async *spec() {
        yield { type: 'spec', spec: { config: {} } }
      },
      async *check() {
        yield { type: 'connection_status', connection_status: { status: 'succeeded' } }
      },
      async *discover() {
        yield {
          type: 'catalog',
          catalog: { streams: [{ name: 'customers', primary_key: [['id']] }] },
        }
      },
      async *read(params) {
        receivedState = params.state
        yield {
          type: 'source_state' as const,
          source_state: { stream: 'customers', data: { status: 'complete' } },
        }
      },
    }

    const engine = await createEngine(makeResolver(stateCapturingSource, destinationTest))
    await drain(
      engine.pipeline_sync(defaultPipeline, {
        state: { streams: { customers: { cursor: 'cus_1' } }, global: {} },
      })
    )

    expect(receivedState).toEqual({
      streams: { customers: { cursor: 'cus_1' } },
      global: {},
    })
  })

  it('returns final eof state by merging run updates into the initial sync state', async () => {
    const source: Source = {
      async *spec() {
        yield { type: 'spec', spec: { config: {} } }
      },
      async *check() {
        yield { type: 'connection_status', connection_status: { status: 'succeeded' } }
      },
      async *discover() {
        yield {
          type: 'catalog',
          catalog: {
            streams: [
              { name: 'customers', primary_key: [['id']] },
              { name: 'invoices', primary_key: [['id']] },
            ],
          },
        }
      },
      async *read() {
        yield {
          type: 'record' as const,
          record: {
            stream: 'customers',
            data: { id: 'cus_1' },
            emitted_at: '2024-01-01T00:00:00.000Z',
          },
        }
        yield {
          type: 'source_state' as const,
          source_state: { stream: 'customers', data: { cursor: 'cus_1' } },
        }
        yield {
          type: 'source_state' as const,
          source_state: { state_type: 'global', data: { events_cursor: 'evt_new' } },
        }
      },
    }

    const engine = await createEngine(makeResolver(source, destinationTest))
    const results = await drain(
      engine.pipeline_sync(defaultPipeline, {
        state: {
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
      })
    )

    const eof = results.find((msg) => msg.type === 'eof')
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

  it('returns the initial sync state unchanged on a no-op resumed run', async () => {
    const idleSource: Source = {
      async *spec() {
        yield { type: 'spec', spec: { config: {} } }
      },
      async *check() {
        yield { type: 'connection_status', connection_status: { status: 'succeeded' } }
      },
      async *discover() {
        yield {
          type: 'catalog',
          catalog: { streams: [{ name: 'customers', primary_key: [['id']] }] },
        }
      },
      async *read() {},
    }

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

    const engine = await createEngine(makeResolver(idleSource, destinationTest))
    const results = await drain(engine.pipeline_sync(defaultPipeline, { state: initialState }))

    const eof = results.find((msg) => msg.type === 'eof')
    expect(eof).toMatchObject({
      type: 'eof',
      eof: { state: initialState },
    })
  })

  it('preserves initial source and destination state when only engine counts change', async () => {
    const recordsOnlySource: Source = {
      async *spec() {
        yield { type: 'spec', spec: { config: {} } }
      },
      async *check() {
        yield { type: 'connection_status', connection_status: { status: 'succeeded' } }
      },
      async *discover() {
        yield {
          type: 'catalog',
          catalog: { streams: [{ name: 'customers', primary_key: [['id']] }] },
        }
      },
      async *read() {
        yield {
          type: 'record' as const,
          record: {
            stream: 'customers',
            data: { id: 'cus_10' },
            emitted_at: '2024-01-01T00:00:00.000Z',
          },
        }
      },
    }

    const engine = await createEngine(makeResolver(recordsOnlySource, destinationTest))
    const results = await drain(
      engine.pipeline_sync(defaultPipeline, {
        state: {
          source: {
            streams: { customers: { cursor: 'cus_9' } },
            global: { events_cursor: 'evt_9' },
          },
          destination: {
            streams: { customers: { watermark: 99 } },
            global: { schema_version: 2 },
          },
          engine: {
            streams: { customers: { cumulative_record_count: 9, note: 'persist' } },
            global: { sync_id: 'resume-9' },
          },
        },
      })
    )

    const eof = results.find((msg) => msg.type === 'eof')
    expect(eof).toMatchObject({
      type: 'eof',
      eof: {
        state: {
          source: {
            streams: { customers: { cursor: 'cus_9' } },
            global: { events_cursor: 'evt_9' },
          },
          destination: {
            streams: { customers: { watermark: 99 } },
            global: { schema_version: 2 },
          },
          engine: {
            streams: { customers: { cumulative_record_count: 10, note: 'persist' } },
            global: { sync_id: 'resume-9' },
          },
        },
      },
    })
  })

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
          {
            type: 'source_state',
            source_state: { stream: 'customers', data: { status: 'complete' } },
          },
        ])
      )
    )

    // pipeline_sync now yields source signals alongside dest output — filter to source_state+eof
    const stateAndEof = results.filter((m) => m.type === 'source_state' || m.type === 'eof')
    expect(stateAndEof).toHaveLength(2)
    expect(stateAndEof[0]).toMatchObject({
      type: 'source_state',
      source_state: { stream: 'customers', data: { status: 'complete' } },
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
          {
            type: 'source_state',
            source_state: { stream: 'customers', data: { status: 'complete' } },
          },
          {
            type: 'record',
            record: {
              stream: 'invoices',
              data: { id: 'inv_1' },
              emitted_at: new Date().toISOString(),
            },
          },
          {
            type: 'source_state',
            source_state: { stream: 'invoices', data: { status: 'complete' } },
          },
        ])
      )
    )

    // Only the customers stream state should come through
    const states = results.filter((r) => r.type === 'source_state')
    expect(states).toHaveLength(1)
    expect((states[0] as SourceStateMessage).source_state.stream).toBe('customers')
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
          type: 'source_state' as const,
          source_state: {
            stream: 'customers',
            data: { after: 'cus_1' },
          },
        }
      },
    }

    const engine = await createEngine(makeResolver(mixedSource, destinationTest))
    const results = await drain(engine.pipeline_sync(defaultPipeline))

    // pipeline_sync now yields source signals (log/trace) alongside dest output
    // Filter to source_state+eof to verify destination processing
    const stateAndEof = results.filter((m) => m.type === 'source_state' || m.type === 'eof')
    expect(stateAndEof).toHaveLength(2)
    expect(stateAndEof[0]!.type).toBe('source_state')
    expect(stateAndEof[1]).toMatchObject({ type: 'eof', eof: { reason: 'complete' } })
    // Source signals (log, trace) are also present in the output
    const sourceSignals = results.filter((m) => m.type === 'log' || m.type === 'trace')
    expect(sourceSignals.length).toBeGreaterThan(0)

    vi.restoreAllMocks()
  })
})

function waitForAbortOrRelease(
  signal: AbortSignal,
  onAbort: () => void,
  setRelease: (release: () => void) => void
): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener('abort', onSignalAbort)
      setRelease(() => undefined)
      resolve()
    }

    const onSignalAbort = () => {
      onAbort()
      finish()
    }

    setRelease(finish)

    if (signal.aborted) {
      onSignalAbort()
      return
    }

    signal.addEventListener('abort', onSignalAbort, { once: true })
  })
}

describe('engine cancellation integration', () => {
  it('pipeline_read() return() aborts a blocked source read', async () => {
    let sourceAborted = false
    let releaseSource = () => undefined

    const source: Source = {
      async *spec() {
        yield { type: 'spec', spec: { config: {} } as any }
      },
      async *discover() {
        yield {
          type: 'catalog',
          catalog: { streams: [{ name: 'customers', primary_key: [['id']] }] },
        } as CatalogMessage
      },
      read() {
        return withAbortOnReturn((signal) =>
          (async function* () {
            yield {
              type: 'record',
              record: {
                stream: 'customers',
                data: { id: 'cus_1' },
                emitted_at: '2024-01-01T00:00:00.000Z',
              },
            } satisfies RecordMessage

            await waitForAbortOrRelease(
              signal,
              () => {
                sourceAborted = true
              },
              (release) => {
                releaseSource = release
              }
            )
          })()
        )
      },
    }

    const engine = await createEngine(makeResolver(source, destinationTest))
    const iter = engine.pipeline_read(defaultPipeline)[Symbol.asyncIterator]()

    expect(await iter.next()).toMatchObject({
      value: { type: 'record', record: { stream: 'customers', data: { id: 'cus_1' } } },
      done: false,
    })

    const blockedNext = iter.next()
    void blockedNext.catch(() => undefined)

    const returnPromise = iter.return?.()

    try {
      await expect(
        Promise.race([
          returnPromise!,
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('timed out waiting for pipeline_read teardown')), 50)
          }),
        ])
      ).resolves.toEqual({ value: undefined, done: true })
    } finally {
      releaseSource()
      await Promise.race([
        returnPromise?.catch(() => undefined) ?? Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, 50)),
      ])
    }

    expect(sourceAborted).toBe(true)
  })

  it('pipeline_sync() return() aborts both source and destination work', async () => {
    let sourceAborted = false
    let destinationAborted = false
    let releaseSource = () => undefined
    let releaseDestination = () => undefined
    let markDestinationWaiting = () => undefined
    const destinationWaiting = new Promise<void>((resolve) => {
      markDestinationWaiting = resolve
    })

    const source: Source = {
      async *spec() {
        yield { type: 'spec', spec: { config: {} } as any }
      },
      async *discover() {
        yield {
          type: 'catalog',
          catalog: { streams: [{ name: 'customers', primary_key: [['id']] }] },
        } as CatalogMessage
      },
      read() {
        return withAbortOnReturn((signal) =>
          (async function* () {
            yield {
              type: 'record',
              record: {
                stream: 'customers',
                data: { id: 'cus_1' },
                emitted_at: '2024-01-01T00:00:00.000Z',
              },
            } satisfies RecordMessage

            await waitForAbortOrRelease(
              signal,
              () => {
                sourceAborted = true
              },
              (release) => {
                releaseSource = release
              }
            )
          })()
        )
      },
    }

    const destination: Destination = {
      async *spec() {
        yield { type: 'spec', spec: { config: {} } as any }
      },
      write(_params, messages) {
        return withAbortOnReturn((signal) =>
          (async function* () {
            for await (const msg of messages) {
              if (msg.type !== 'record') continue

              yield {
                type: 'source_state',
                source_state: {
                  stream: 'customers',
                  data: { cursor: 'cus_1' },
                },
              } satisfies SourceStateMessage

              markDestinationWaiting()
              await waitForAbortOrRelease(
                signal,
                () => {
                  destinationAborted = true
                },
                (release) => {
                  releaseDestination = release
                }
              )
            }
          })()
        )
      },
    }

    const engine = await createEngine(makeResolver(source, destination))
    const iter = engine.pipeline_sync(defaultPipeline)[Symbol.asyncIterator]()

    expect(await iter.next()).toMatchObject({
      value: {
        type: 'source_state',
        source_state: { stream: 'customers', data: { cursor: 'cus_1' } },
      },
      done: false,
    })

    const blockedNext = iter.next()
    void blockedNext.catch(() => undefined)
    await Promise.race([
      destinationWaiting,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('destination never entered the blocked section')), 50)
      }),
    ])

    const returnPromise = iter.return?.()

    try {
      await expect(
        Promise.race([
          returnPromise!,
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('timed out waiting for pipeline_sync teardown')), 50)
          }),
        ])
      ).resolves.toEqual({ value: undefined, done: true })
    } finally {
      releaseSource()
      releaseDestination()
      await Promise.race([
        returnPromise?.catch(() => undefined) ?? Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, 50)),
      ])
    }

    expect(sourceAborted).toBe(true)
    expect(destinationAborted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// injectTimeRanges tests
// ---------------------------------------------------------------------------

describe('injectTimeRanges', () => {
  function mkCatalog(streamNames: string[]) {
    return buildCatalog(streamNames.map((name) => ({ name, primary_key: [['id']] })))
  }

  it('does nothing when engineState is undefined', () => {
    const catalog = mkCatalog(['customers'])
    injectTimeRanges(catalog, undefined)
    expect(catalog.streams[0]!.time_range).toBeUndefined()
  })

  it('does nothing when stream has no completed_ranges', () => {
    const catalog = mkCatalog(['customers'])
    injectTimeRanges(catalog, {
      streams: { customers: { cumulative_record_count: 5 } },
      global: {},
    })
    expect(catalog.streams[0]!.time_range).toBeUndefined()
  })

  it('sets time_range.gte to max lt of completed_ranges', () => {
    const catalog = mkCatalog(['customers'])
    injectTimeRanges(catalog, {
      streams: {
        customers: {
          completed_ranges: [
            { gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' },
            { gte: '2024-06-01T00:00:00Z', lt: '2024-09-01T00:00:00Z' },
          ],
        },
      },
      global: {},
    })
    expect(catalog.streams[0]!.time_range!.gte).toBe('2024-09-01T00:00:00Z')
    expect(catalog.streams[0]!.time_range!.lt).toBeDefined()
  })

  it('preserves existing time_range.lt if already set', () => {
    const catalog = mkCatalog(['customers'])
    catalog.streams[0]!.time_range = {
      gte: '2024-01-01T00:00:00Z',
      lt: '2025-06-01T00:00:00Z',
    }
    injectTimeRanges(catalog, {
      streams: {
        customers: {
          completed_ranges: [{ gte: '2024-01-01T00:00:00Z', lt: '2024-09-01T00:00:00Z' }],
        },
      },
      global: {},
    })
    expect(catalog.streams[0]!.time_range).toEqual({
      gte: '2024-09-01T00:00:00Z',
      lt: '2025-06-01T00:00:00Z',
    })
  })

  it('only injects into streams with completed_ranges', () => {
    const catalog = mkCatalog(['customers', 'invoices'])
    injectTimeRanges(catalog, {
      streams: {
        customers: {
          completed_ranges: [{ gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' }],
        },
      },
      global: {},
    })
    expect(catalog.streams[0]!.time_range!.gte).toBe('2024-06-01T00:00:00Z')
    expect(catalog.streams[1]!.time_range).toBeUndefined()
  })

  it('skips streams with supports_time_range: false', () => {
    const catalog = mkCatalog(['customers'])
    catalog.streams[0]!.supports_time_range = false
    injectTimeRanges(catalog, {
      streams: {
        customers: {
          completed_ranges: [{ gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' }],
        },
      },
      global: {},
    })
    expect(catalog.streams[0]!.time_range).toBeUndefined()
  })

  it('injects into streams with supports_time_range: true', () => {
    const catalog = mkCatalog(['customers'])
    catalog.streams[0]!.supports_time_range = true
    injectTimeRanges(catalog, {
      streams: {
        customers: {
          completed_ranges: [{ gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' }],
        },
      },
      global: {},
    })
    expect(catalog.streams[0]!.time_range!.gte).toBe('2024-06-01T00:00:00Z')
  })

  it('injects into streams with supports_time_range: undefined (default)', () => {
    const catalog = mkCatalog(['customers'])
    // supports_time_range is not set (undefined) — should still inject
    injectTimeRanges(catalog, {
      streams: {
        customers: {
          completed_ranges: [{ gte: '2024-01-01T00:00:00Z', lt: '2024-06-01T00:00:00Z' }],
        },
      },
      global: {},
    })
    expect(catalog.streams[0]!.time_range!.gte).toBe('2024-06-01T00:00:00Z')
  })
})
