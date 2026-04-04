import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import type { ConnectorResolver, Message } from './index.js'
import { sourceTest, destinationTest, collectSpec } from './index.js'
import { createApp } from '../api/app.js'
import { createRemoteEngine } from './remote-engine.js'
import type { PipelineConfig, StateMessage } from '@stripe/sync-protocol'

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

/** Extract the raw config JSON Schema from a connector's async iterable spec(). */
async function getRawConfigJsonSchema(
  connector: typeof sourceTest | typeof destinationTest
): Promise<Record<string, unknown>> {
  const { spec } = await collectSpec(
    connector.spec() as AsyncIterable<import('@stripe/sync-protocol').Message>
  )
  return spec.config
}

vi.spyOn(console, 'info').mockImplementation(() => undefined)
vi.spyOn(console, 'error').mockImplementation(() => undefined)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any
let engineUrl: string

const pipeline: PipelineConfig = {
  source: { type: 'test', streams: { customers: {} } },
  destination: { type: 'test' },
}

beforeAll(async () => {
  const [srcConfigSchema, destConfigSchema] = await Promise.all([
    getRawConfigJsonSchema(sourceTest),
    getRawConfigJsonSchema(destinationTest),
  ])
  const resolver: ConnectorResolver = {
    resolveSource: async (name) => {
      if (name !== 'test') throw new Error(`Unknown source connector: ${name}`)
      return sourceTest
    },
    resolveDestination: async (name) => {
      if (name !== 'test') throw new Error(`Unknown destination connector: ${name}`)
      return destinationTest
    },
    sources: () =>
      new Map([
        [
          'test',
          {
            connector: sourceTest,
            configSchema: {} as any,
            rawConfigJsonSchema: srcConfigSchema,
          },
        ],
      ]),
    destinations: () =>
      new Map([
        [
          'test',
          {
            connector: destinationTest,
            configSchema: {} as any,
            rawConfigJsonSchema: destConfigSchema,
          },
        ],
      ]),
  }

  const app = await createApp(resolver)
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      engineUrl = `http://localhost:${(info as AddressInfo).port}`
      resolve()
    })
  })
})

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((err: Error | null) => (err ? reject(err) : resolve()))
    })
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) items.push(item)
  return items
}

async function* asIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createRemoteEngine', () => {
  describe('pipeline_setup()', () => {
    it('resolves without error', async () => {
      const engine = createRemoteEngine(engineUrl)
      await expect(engine.pipeline_setup(pipeline)).resolves.toEqual({})
    })
  })

  describe('pipeline_teardown()', () => {
    it('resolves without error', async () => {
      const engine = createRemoteEngine(engineUrl)
      await expect(engine.pipeline_teardown(pipeline)).resolves.toBeUndefined()
    })
  })

  describe('pipeline_check()', () => {
    it('returns source and destination check results', async () => {
      const engine = createRemoteEngine(engineUrl)
      const result = await engine.pipeline_check(pipeline)
      expect(result).toEqual({
        source: { status: 'succeeded' },
        destination: { status: 'succeeded' },
      })
    })
  })

  describe('pipeline_read()', () => {
    it('streams messages from input iterable', async () => {
      const engine = createRemoteEngine(engineUrl)
      const input: Message[] = [
        {
          type: 'record',
          record: {
            stream: 'customers',
            data: { id: 'cus_1' },
            emitted_at: '2024-01-01T00:00:00.000Z',
          },
        },
        { type: 'state', state: { stream: 'customers', data: { cursor: 'cus_1' } } },
      ]
      const messages = await collect(engine.pipeline_read(pipeline, undefined, asIterable(input)))
      expect(messages).toHaveLength(3)
      expect(messages[0]!.type).toBe('record')
      expect(messages[1]!.type).toBe('state')
      expect(messages[2]).toMatchObject({ type: 'eof', eof: { reason: 'complete' } })
    })

    it('returns eof:complete when called without input', async () => {
      const engine = createRemoteEngine(engineUrl)
      // sourceTest yields nothing when $stdin is absent — only eof
      const messages = await collect(engine.pipeline_read(pipeline))
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ type: 'eof', eof: { reason: 'complete' } })
    })
  })

  describe('pipeline_write()', () => {
    it('yields only state messages (destinationTest behaviour)', async () => {
      const engine = createRemoteEngine(engineUrl)
      const messages: Message[] = [
        {
          type: 'record',
          record: {
            stream: 'customers',
            data: { id: 'cus_1' },
            emitted_at: '2024-01-01T00:00:00.000Z',
          },
        },
        { type: 'state', state: { stream: 'customers', data: { cursor: 'cus_1' } } },
      ]
      const output = await collect(engine.pipeline_write(pipeline, asIterable(messages)))
      expect(output).toHaveLength(1)
      expect(output[0]!.type).toBe('state')
      expect((output[0] as StateMessage).state.stream).toBe('customers')
    })
  })

  describe('pipeline_sync()', () => {
    it('runs full pipeline and yields state messages', async () => {
      const engine = createRemoteEngine(engineUrl)
      const input: Message[] = [
        {
          type: 'record',
          record: {
            stream: 'customers',
            data: { id: 'cus_1' },
            emitted_at: '2024-01-01T00:00:00.000Z',
          },
        },
        { type: 'state', state: { stream: 'customers', data: { cursor: 'cus_1' } } },
      ]
      const output = await collect(engine.pipeline_sync(pipeline, undefined, asIterable(input)))
      expect(output).toHaveLength(2)
      expect(output[0]!.type).toBe('state')
      expect(output[1]).toMatchObject({ type: 'eof', eof: { reason: 'complete' } })
    })

    it('returns eof:complete without input (no source data)', async () => {
      const engine = createRemoteEngine(engineUrl)
      const output = await collect(engine.pipeline_sync(pipeline))
      expect(output).toHaveLength(1)
      expect(output[0]).toMatchObject({ type: 'eof', eof: { reason: 'complete' } })
    })
  })

  describe('meta_sources_list()', () => {
    it('returns available source connectors as array', async () => {
      const engine = createRemoteEngine(engineUrl)
      const result = await engine.meta_sources_list()
      expect(Array.isArray(result.items)).toBe(true)
      expect(result.items.find((c) => c.type === 'test')).toHaveProperty('config_schema')
    })
  })

  describe('meta_source()', () => {
    it('returns spec for a known source type', async () => {
      const engine = createRemoteEngine(engineUrl)
      const result = await engine.meta_source('test')
      expect(result).toHaveProperty('config_schema')
    })

    it('throws for an unknown source type', async () => {
      const engine = createRemoteEngine(engineUrl)
      await expect(engine.meta_source('nonexistent')).rejects.toThrow()
    })
  })

  describe('meta_destinations_list()', () => {
    it('returns available destination connectors as array', async () => {
      const engine = createRemoteEngine(engineUrl)
      const result = await engine.meta_destinations_list()
      expect(Array.isArray(result.items)).toBe(true)
      expect(result.items.find((c) => c.type === 'test')).toHaveProperty('config_schema')
    })
  })

  describe('meta_destination()', () => {
    it('returns spec for a known destination type', async () => {
      const engine = createRemoteEngine(engineUrl)
      const result = await engine.meta_destination('test')
      expect(result).toHaveProperty('config_schema')
    })

    it('throws for an unknown destination type', async () => {
      const engine = createRemoteEngine(engineUrl)
      await expect(engine.meta_destination('nonexistent')).rejects.toThrow()
    })
  })

  describe('error handling', () => {
    it('throws on HTTP errors (nonexistent connector)', async () => {
      const badPipeline: PipelineConfig = {
        source: { type: 'nonexistent' },
        destination: { type: 'nonexistent' },
      }
      const engine = createRemoteEngine(engineUrl)
      await expect(engine.pipeline_setup(badPipeline)).rejects.toThrow(/failed/)
    })
  })
})
