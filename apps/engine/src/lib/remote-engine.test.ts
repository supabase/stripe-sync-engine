import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import type { ConnectorResolver, Message } from './index.js'
import { sourceTest, destinationTest } from './index.js'
import { createApp } from '../api/app.js'
import { createRemoteEngine } from './remote-engine.js'
import type { PipelineConfig } from '@stripe/sync-protocol'

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

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
          rawConfigJsonSchema: sourceTest.spec().config,
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
          rawConfigJsonSchema: destinationTest.spec().config,
        },
      ],
    ]),
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

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      const app = createApp(resolver)
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        engineUrl = `http://localhost:${(info as AddressInfo).port}`
        resolve()
      })
    })
)

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
  describe('setup()', () => {
    it('resolves without error', async () => {
      const engine = createRemoteEngine(engineUrl, pipeline)
      await expect(engine.setup()).resolves.toEqual({})
    })
  })

  describe('teardown()', () => {
    it('resolves without error', async () => {
      const engine = createRemoteEngine(engineUrl, pipeline)
      await expect(engine.teardown()).resolves.toBeUndefined()
    })
  })

  describe('check()', () => {
    it('returns source and destination check results', async () => {
      const engine = createRemoteEngine(engineUrl, pipeline)
      const result = await engine.check()
      expect(result).toEqual({
        source: { status: 'succeeded' },
        destination: { status: 'succeeded' },
      })
    })
  })

  describe('read()', () => {
    it('streams messages from input iterable', async () => {
      const engine = createRemoteEngine(engineUrl, pipeline)
      const input: Message[] = [
        {
          type: 'record',
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
        { type: 'state', stream: 'customers', data: { cursor: 'cus_1' } },
      ]
      const messages = await collect(engine.read(asIterable(input)))
      expect(messages).toHaveLength(2)
      expect(messages[0]!.type).toBe('record')
      expect(messages[1]!.type).toBe('state')
    })

    it('returns empty stream when called without input', async () => {
      const engine = createRemoteEngine(engineUrl, pipeline)
      // sourceTest yields nothing when $stdin is absent
      const messages = await collect(engine.read())
      expect(messages).toHaveLength(0)
    })
  })

  describe('write()', () => {
    it('yields only state messages (destinationTest behaviour)', async () => {
      const engine = createRemoteEngine(engineUrl, pipeline)
      const messages: Message[] = [
        {
          type: 'record',
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
        { type: 'state', stream: 'customers', data: { cursor: 'cus_1' } },
      ]
      const output = await collect(engine.write(asIterable(messages)))
      expect(output).toHaveLength(1)
      expect(output[0]!.type).toBe('state')
      expect((output[0] as { stream: string }).stream).toBe('customers')
    })
  })

  describe('sync()', () => {
    it('runs full pipeline and yields state messages', async () => {
      const engine = createRemoteEngine(engineUrl, pipeline)
      const input: Message[] = [
        {
          type: 'record',
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
        { type: 'state', stream: 'customers', data: { cursor: 'cus_1' } },
      ]
      const output = await collect(engine.sync(asIterable(input)))
      expect(output).toHaveLength(1)
      expect(output[0]!.type).toBe('state')
    })

    it('returns empty stream without input (no source data)', async () => {
      const engine = createRemoteEngine(engineUrl, pipeline)
      const output = await collect(engine.sync())
      expect(output).toHaveLength(0)
    })
  })

  describe('error handling', () => {
    it('throws on HTTP errors (nonexistent connector)', async () => {
      const badPipeline: PipelineConfig = {
        source: { type: 'nonexistent' },
        destination: { type: 'nonexistent' },
      }
      const engine = createRemoteEngine(engineUrl, badPipeline)
      await expect(engine.setup()).rejects.toThrow(/failed/)
    })
  })
})
