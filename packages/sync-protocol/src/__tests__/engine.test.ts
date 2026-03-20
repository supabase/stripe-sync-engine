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
  SyncParams,
} from '../protocol'
import type { Source, Destination, DestinationInput as DestInput } from '../protocol'
import { createEngine, buildCatalog } from '../engine'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item
  }
}

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of iter) {
    result.push(item)
  }
  return result
}

function mockSource(messages: Message[], catalog?: CatalogMessage): Source {
  return {
    spec: () => ({ config: {} }),
    check: async () => ({ status: 'succeeded' }),
    discover: async () =>
      catalog ?? { type: 'catalog', streams: [{ name: 'customers', primary_key: [['id']] }] },
    read: () => toAsync(messages),
  }
}

function mockDestination(): { destination: Destination; received: DestInput[] } {
  const received: DestInput[] = []
  return {
    received,
    destination: {
      spec: () => ({ config: {} }),
      check: async () => ({ status: 'succeeded' }),
      write: (_params, $stdin) =>
        (async function* () {
          for await (const msg of $stdin) {
            received.push(msg)
            if (msg.type === 'state') yield msg
          }
        })(),
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

  describe('SyncParams', () => {
    it('parses minimal params', () => {
      const result = SyncParams.parse({
        destination: 'postgres',
        source_config: {},
        destination_config: {},
      })
      expect(result.source).toBe('stripe') // default
      expect(result.destination).toBe('postgres')
      expect(result.source_config).toEqual({})
    })

    it('parses with all fields', () => {
      const result = SyncParams.parse({
        source: 'stripe',
        destination: 'postgres',
        source_config: { api_key: 'sk_test' },
        destination_config: { url: 'pg://...' },
        streams: [{ name: 'customers', sync_mode: 'incremental' }],
        state: { customers: { cursor: 'abc' } },
      })
      expect(result.streams).toHaveLength(1)
      expect(result.state).toEqual({ customers: { cursor: 'abc' } })
    })

    it('rejects missing destination', () => {
      expect(() => SyncParams.parse({ source_config: {}, destination_config: {} })).toThrow()
    })
  })
})

// ---------------------------------------------------------------------------
// Config validation tests
// ---------------------------------------------------------------------------

describe('engine config validation', () => {
  it('creates engine with valid configs', () => {
    const source = mockSource([])
    const { destination } = mockDestination()
    expect(() =>
      createEngine(
        { destination: 'postgres', source_config: {}, destination_config: {} },
        { source, destination }
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
      read: () => toAsync([]),
    }
    const { destination } = mockDestination()
    expect(() =>
      createEngine(
        { destination: 'postgres', source_config: {}, destination_config: {} },
        { source, destination }
      )
    ).toThrow()
  })

  it('throws on invalid destination config', () => {
    const source = mockSource([])
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
        { destination: 'postgres', source_config: {}, destination_config: {} },
        { source, destination }
      )
    ).toThrow()
  })

  it('applies defaults from connector spec', () => {
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
      read: () => toAsync([]),
    }
    const { destination } = mockDestination()

    const engine = createEngine(
      { destination: 'postgres', source_config: {}, destination_config: {} },
      { source, destination }
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
  it('valid messages pass through', async () => {
    const record: RecordMessage = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_1' },
      emitted_at: 1000,
    }
    const state: StateMessage = {
      type: 'state',
      stream: 'customers',
      data: { cursor: 'abc' },
    }

    const source = mockSource([record, state])
    const { destination } = mockDestination()
    const engine = createEngine(
      { destination: 'postgres', source_config: {}, destination_config: {} },
      { source, destination }
    )

    const results = await drain(engine.read())
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
      read: () =>
        toAsync([
          // Missing required fields — not a valid Message
          { type: 'record', stream: 'customers' } as unknown as Message,
        ]),
    }
    const { destination } = mockDestination()
    const engine = createEngine(
      { destination: 'postgres', source_config: {}, destination_config: {} },
      { source: badSource, destination }
    )

    await expect(drain(engine.read())).rejects.toThrow()
  })

  it('destination output validation catches malformed messages', async () => {
    const record: RecordMessage = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_1' },
      emitted_at: 1000,
    }

    const source = mockSource([record])
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
      { destination: 'postgres', source_config: {}, destination_config: {} },
      { source, destination: badDest }
    )

    await expect(drain(engine.run())).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Stream membership validation tests
// ---------------------------------------------------------------------------

describe('engine stream membership validation', () => {
  it('record with known stream passes through', async () => {
    const record: RecordMessage = {
      type: 'record',
      stream: 'customers',
      data: { id: 'cus_1' },
      emitted_at: 1000,
    }
    const source = mockSource([record])
    const { destination } = mockDestination()
    const engine = createEngine(
      { destination: 'postgres', source_config: {}, destination_config: {} },
      { source, destination }
    )

    const results = await drain(engine.read())
    expect(results).toHaveLength(1)
    expect(results[0]!.type).toBe('record')
  })

  it('record with unknown stream triggers error callback and is dropped', async () => {
    const record: RecordMessage = {
      type: 'record',
      stream: 'unknown_stream',
      data: { id: '1' },
      emitted_at: 1000,
    }
    const source = mockSource([record])
    const { destination } = mockDestination()
    const onError = vi.fn()
    const engine = createEngine(
      { destination: 'postgres', source_config: {}, destination_config: {} },
      { source, destination },
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
    const state: StateMessage = {
      type: 'state',
      stream: 'nonexistent',
      data: { cursor: 'x' },
    }
    const source = mockSource([state])
    const { destination } = mockDestination()
    const onError = vi.fn()
    const engine = createEngine(
      { destination: 'postgres', source_config: {}, destination_config: {} },
      { source, destination },
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
    const log: LogMessage = { type: 'log', level: 'info', message: 'hello' }
    const error: ErrorMessage = {
      type: 'error',
      failure_type: 'system_error',
      message: 'oops',
      stream: 'nonexistent',
    }
    const source = mockSource([log, error])
    const { destination } = mockDestination()
    const engine = createEngine(
      { destination: 'postgres', source_config: {}, destination_config: {} },
      { source, destination }
    )

    const results = await drain(engine.read())
    expect(results).toHaveLength(2)
    expect(results[0]!.type).toBe('log')
    expect(results[1]!.type).toBe('error')
  })
})
