import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  RecordMessage,
  StateMessage,
  CatalogMessage,
  LogMessage,
  ErrorMessage,
  StreamStatusMessage,
  DestinationInput,
  DestinationOutput,
  Message,
  Stream,
  ConfiguredStream,
  ConfiguredCatalog,
  ConnectorSpecification,
  CheckResult,
  SyncEngineParams,
} from '@stripe/protocol'
import type { Source, Destination, DestinationInput as DestInput } from '@stripe/protocol'
import { createEngine, buildCatalog } from './engine'
import { sourceTest } from './source-test'
import { destinationTest } from './destination-test'

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

// ---------------------------------------------------------------------------
// Protocol schema tests
// ---------------------------------------------------------------------------

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

  describe('CheckResult', () => {
    it('parses succeeded', () => {
      expect(CheckResult.parse({ status: 'succeeded' })).toEqual({ status: 'succeeded' })
    })

    it('parses failed with message', () => {
      expect(CheckResult.parse({ status: 'failed', message: 'bad creds' })).toEqual({
        status: 'failed',
        message: 'bad creds',
      })
    })

    it('rejects invalid status', () => {
      expect(() => CheckResult.parse({ status: 'unknown' })).toThrow()
    })
  })

  describe('messages', () => {
    it('RecordMessage', () => {
      const msg = RecordMessage.parse({
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1' },
        emitted_at: 1000,
      })
      expect(msg.type).toBe('record')
      expect(msg.data).toEqual({ id: 'cus_1' })
    })

    it('StateMessage', () => {
      const msg = StateMessage.parse({
        type: 'state',
        stream: 'customers',
        data: { cursor: 'abc' },
      })
      expect(msg.type).toBe('state')
    })

    it('CatalogMessage', () => {
      const msg = CatalogMessage.parse({
        type: 'catalog',
        streams: [{ name: 'users', primary_key: [['id']] }],
      })
      expect(msg.streams).toHaveLength(1)
    })

    it('LogMessage', () => {
      const msg = LogMessage.parse({ type: 'log', level: 'info', message: 'hello' })
      expect(msg.level).toBe('info')
    })

    it('ErrorMessage', () => {
      const msg = ErrorMessage.parse({
        type: 'error',
        failure_type: 'transient_error',
        message: 'retry',
        stream: 'customers',
        stack_trace: 'Error at ...',
      })
      expect(msg.failure_type).toBe('transient_error')
      expect(msg.stream).toBe('customers')
    })

    it('StreamStatusMessage', () => {
      const msg = StreamStatusMessage.parse({
        type: 'stream_status',
        stream: 'customers',
        status: 'running',
      })
      expect(msg.status).toBe('running')
    })

    it('rejects missing type', () => {
      expect(() => RecordMessage.parse({ stream: 'x', data: {}, emitted_at: 1 })).toThrow()
    })

    it('rejects wrong type literal', () => {
      expect(() =>
        RecordMessage.parse({ type: 'state', stream: 'x', data: {}, emitted_at: 1 })
      ).toThrow()
    })
  })

  describe('Message discriminated union', () => {
    it('parses all 6 message types', () => {
      const messages = [
        { type: 'record', stream: 's', data: {}, emitted_at: 1 },
        { type: 'state', stream: 's', data: null },
        { type: 'catalog', streams: [{ name: 's', primary_key: [['id']] }] },
        { type: 'log', level: 'info', message: 'hi' },
        { type: 'error', failure_type: 'system_error', message: 'bad' },
        { type: 'stream_status', stream: 's', status: 'complete' },
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
        DestinationInput.parse({ type: 'record', stream: 's', data: {}, emitted_at: 1 })
      ).not.toThrow()
      expect(() => DestinationInput.parse({ type: 'state', stream: 's', data: null })).not.toThrow()
    })

    it('rejects log message', () => {
      expect(() => DestinationInput.parse({ type: 'log', level: 'info', message: 'hi' })).toThrow()
    })
  })

  describe('DestinationOutput', () => {
    it('accepts state, error, and log', () => {
      expect(() =>
        DestinationOutput.parse({ type: 'state', stream: 's', data: null })
      ).not.toThrow()
      expect(() =>
        DestinationOutput.parse({ type: 'error', failure_type: 'system_error', message: 'x' })
      ).not.toThrow()
      expect(() =>
        DestinationOutput.parse({ type: 'log', level: 'warn', message: 'x' })
      ).not.toThrow()
    })

    it('rejects record message', () => {
      expect(() =>
        DestinationOutput.parse({ type: 'record', stream: 's', data: {}, emitted_at: 1 })
      ).toThrow()
    })
  })

  describe('SyncEngineParams', () => {
    it('parses minimal params', () => {
      const result = SyncEngineParams.parse({
        source_config: {},
        destination_config: {},
      })
      expect(result.source_config).toEqual({})
      expect(result.destination_config).toEqual({})
    })

    it('parses with all fields', () => {
      const result = SyncEngineParams.parse({
        source_config: { api_key: 'sk_test' },
        destination_config: { url: 'pg://...' },
        streams: [{ name: 'customers', sync_mode: 'incremental' }],
        state: { customers: { cursor: 'abc' } },
      })
      expect(result.streams).toHaveLength(1)
      expect(result.state).toEqual({ customers: { cursor: 'abc' } })
    })

    it('rejects missing source_config', () => {
      expect(() => SyncEngineParams.parse({ destination_config: {} })).toThrow()
    })

    it('rejects missing destination_config', () => {
      expect(() => SyncEngineParams.parse({ source_config: {} })).toThrow()
    })
  })
})

// ---------------------------------------------------------------------------
// Config validation tests
// ---------------------------------------------------------------------------

describe('engine config validation', () => {
  it('creates engine with valid configs', () => {
    expect(() =>
      createEngine(
        {
          source_config: { streams: {} },
          destination_config: {},
        },
        { source: sourceTest, destination: destinationTest }
      )
    ).not.toThrow()
  })

  it('throws on invalid source config', () => {
    const source: Source = {
      spec: () => ({
        config: z.toJSONSchema(z.object({ api_key: z.string() })),
      }),
      check: async () => ({ status: 'succeeded' }),
      discover: async () => ({ type: 'catalog', streams: [] }),
      read: async function* () {},
    }
    expect(() =>
      createEngine(
        { source_config: {}, destination_config: {} },
        { source, destination: destinationTest }
      )
    ).toThrow()
  })

  it('throws on invalid destination config', () => {
    const destination: Destination = {
      spec: () => ({
        config: z.toJSONSchema(z.object({ url: z.string() })),
      }),
      check: async () => ({ status: 'succeeded' }),
      write: (_params, $stdin) =>
        (async function* () {
          for await (const _ of $stdin) {
            /* drain */
          }
        })(),
    }
    expect(() =>
      createEngine(
        {
          source_config: { streams: {} },
          destination_config: {},
        },
        { source: sourceTest, destination }
      )
    ).toThrow()
  })

  it('applies defaults from connector spec', async () => {
    const source: Source = {
      spec: () => ({
        config: z.toJSONSchema(z.object({ schema: z.string().default('stripe') })),
      }),
      check: async () => ({ status: 'succeeded' }),
      discover: async ({ config }) => {
        // The engine should pass config with defaults applied
        expect(config).toEqual({ schema: 'stripe' })
        return { type: 'catalog', streams: [] }
      },
      read: async function* () {},
    }

    const engine = createEngine(
      { source_config: {}, destination_config: {} },
      { source, destination: destinationTest }
    )
    // Trigger discover to verify the default was applied
    return drain(engine.run())
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
  it('valid messages pass through engine.read()', async () => {
    const engine = createEngine(
      {
        source_config: { streams: { customers: {} } },
        destination_config: {},
      },
      { source: sourceTest, destination: destinationTest }
    )

    const results = await drain(
      engine.read(
        toAsync([
          { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: Date.now() },
          { type: 'state', stream: 'customers', data: { status: 'complete' } },
        ])
      )
    )
    expect(results).toHaveLength(2)
    expect(results[0]!.type).toBe('record')
    expect(results[1]!.type).toBe('state')
  })

  it('malformed source message throws', async () => {
    const badSource: Source = {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' }),
      discover: async () => ({
        type: 'catalog',
        streams: [{ name: 'customers', primary_key: [['id']] }],
      }),
      read: async function* () {
        // Missing required fields — not a valid Message
        yield { type: 'record', stream: 'customers' } as unknown as Message
      },
    }
    const engine = createEngine(
      { source_config: {}, destination_config: {} },
      { source: badSource, destination: destinationTest }
    )

    await expect(drain(engine.read())).rejects.toThrow()
  })

  it('destination output validation catches malformed messages', async () => {
    const badDest: Destination = {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' }),
      write: (_params, $stdin) =>
        (async function* () {
          for await (const _ of $stdin) {
            /* drain */
          }
          // Yield a malformed message
          yield { type: 'bad' } as unknown as DestinationOutput
        })(),
    }

    const engine = createEngine(
      {
        source_config: { streams: { customers: {} } },
        destination_config: {},
      },
      { source: sourceTest, destination: badDest }
    )

    await expect(
      drain(
        engine.run(
          toAsync([
            { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: Date.now() },
            { type: 'state', stream: 'customers', data: { status: 'complete' } },
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
    const engine = createEngine(
      {
        source_config: { streams: { customers: {} } },
        destination_config: {},
      },
      { source: sourceTest, destination: destinationTest }
    )

    const results = await drain(
      engine.read(
        toAsync([
          { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: Date.now() },
          { type: 'state', stream: 'customers', data: { status: 'complete' } },
        ])
      )
    )
    expect(results.filter((m) => m.type === 'record')).toHaveLength(1)
  })

  it('record with unknown stream triggers error callback and is dropped', async () => {
    // Source that emits a record for a stream not in the catalog
    const badSource: Source = {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' }),
      discover: async () => ({
        type: 'catalog',
        streams: [{ name: 'customers', primary_key: [['id']] }],
      }),
      read: async function* () {
        yield {
          type: 'record' as const,
          stream: 'unknown_stream',
          data: { id: '1' },
          emitted_at: 1000,
        }
      },
    }
    const onError = vi.fn()
    const engine = createEngine(
      { source_config: {}, destination_config: {} },
      { source: badSource, destination: destinationTest },
      { onError }
    )

    const results = await drain(engine.read())
    expect(results).toHaveLength(0)
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(
      'Unknown stream "unknown_stream" not in catalog',
      'system_error'
    )
  })

  it('state with unknown stream triggers error callback and is dropped', async () => {
    const badSource: Source = {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' }),
      discover: async () => ({
        type: 'catalog',
        streams: [{ name: 'customers', primary_key: [['id']] }],
      }),
      read: async function* () {
        yield {
          type: 'state' as const,
          stream: 'nonexistent',
          data: { cursor: 'x' },
        }
      },
    }
    const onError = vi.fn()
    const engine = createEngine(
      { source_config: {}, destination_config: {} },
      { source: badSource, destination: destinationTest },
      { onError }
    )

    const results = await drain(engine.read())
    expect(results).toHaveLength(0)
    expect(onError).toHaveBeenCalledWith(
      'Unknown stream "nonexistent" not in catalog',
      'system_error'
    )
  })

  it('non-stream messages pass through regardless of stream field', async () => {
    // Source that emits log + error messages (which don't require stream membership)
    const source: Source = {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' }),
      discover: async () => ({
        type: 'catalog',
        streams: [{ name: 'customers', primary_key: [['id']] }],
      }),
      read: async function* () {
        yield { type: 'log' as const, level: 'info' as const, message: 'hello' }
        yield {
          type: 'error' as const,
          failure_type: 'system_error' as const,
          message: 'oops',
          stream: 'nonexistent',
        }
      },
    }
    const engine = createEngine(
      { source_config: {}, destination_config: {} },
      { source, destination: destinationTest }
    )

    const results = await drain(engine.read())
    expect(results).toHaveLength(2)
    expect(results[0]!.type).toBe('log')
    expect(results[1]!.type).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// engine.run() pipeline tests
// ---------------------------------------------------------------------------

describe('engine.run() pipeline', () => {
  it('basic pipeline: yields state messages from source → destination', async () => {
    const engine = createEngine(
      {
        source_config: { streams: { customers: {} } },
        destination_config: {},
      },
      { source: sourceTest, destination: destinationTest }
    )
    const results = await drain(
      engine.run(
        toAsync([
          {
            type: 'record',
            stream: 'customers',
            data: { id: 'cus_1', name: 'Alice' },
            emitted_at: Date.now(),
          },
          {
            type: 'record',
            stream: 'customers',
            data: { id: 'cus_2', name: 'Bob' },
            emitted_at: Date.now(),
          },
          {
            type: 'record',
            stream: 'customers',
            data: { id: 'cus_3', name: 'Charlie' },
            emitted_at: Date.now(),
          },
          { type: 'state', stream: 'customers', data: { status: 'complete' } },
        ])
      )
    )

    // Pipeline yields 1 state message (destinationTest passes state through)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      type: 'state',
      stream: 'customers',
      data: { status: 'complete' },
    })
  })

  it('stream filtering: only configures requested streams', async () => {
    const engine = createEngine(
      {
        source_config: { streams: { customers: {}, invoices: {} } },
        destination_config: {},
        streams: [{ name: 'customers' }],
      },
      { source: sourceTest, destination: destinationTest }
    )
    const results = await drain(
      engine.run(
        toAsync([
          { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: Date.now() },
          { type: 'state', stream: 'customers', data: { status: 'complete' } },
          { type: 'record', stream: 'invoices', data: { id: 'inv_1' }, emitted_at: Date.now() },
          { type: 'state', stream: 'invoices', data: { status: 'complete' } },
        ])
      )
    )

    // Only the customers stream state should come through
    expect(results).toHaveLength(1)
    expect(results[0]!.stream).toBe('customers')
  })

  it('non-data messages filtered: only record + state reach destination', async () => {
    // Source that emits log, error, stream_status, record, and state —
    // only record + state should reach the destination (non-data messages are routed to callbacks)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const mixedSource: Source = {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' }),
      discover: async () => ({
        type: 'catalog',
        streams: [{ name: 'customers', primary_key: [['id']] }],
      }),
      read: async function* () {
        yield { type: 'log' as const, level: 'info' as const, message: 'starting' }
        yield {
          type: 'error' as const,
          failure_type: 'transient_error' as const,
          message: 'rate limited',
        }
        yield {
          type: 'stream_status' as const,
          stream: 'customers',
          status: 'running' as const,
        }
        yield {
          type: 'record' as const,
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: 1000,
        }
        yield {
          type: 'state' as const,
          stream: 'customers',
          data: { after: 'cus_1' },
        }
      },
    }

    const engine = createEngine(
      { source_config: {}, destination_config: {} },
      { source: mixedSource, destination: destinationTest }
    )
    const results = await drain(engine.run())

    // Only the state message passes through engine.run() (record goes to dest but
    // dest only yields state back; log/error/stream_status are routed to callbacks)
    expect(results).toHaveLength(1)
    expect(results[0]!.type).toBe('state')

    vi.restoreAllMocks()
  })
})
