import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { ConnectorResolver } from '@stripe/sync-engine'
import { sourceTest, destinationTest, createApp } from '@stripe/sync-engine'
import type { PipelineConfig } from '@stripe/sync-engine'
import { createActivities } from '../temporal/activities.js'

// Mock Temporal heartbeat — activities call it but we're outside a workflow context
vi.mock('@temporalio/activity', () => ({
  heartbeat: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Test server setup: engine + mock service
// ---------------------------------------------------------------------------

const resolver: ConnectorResolver = {
  resolveSource: async (name) => {
    if (name !== 'test') throw new Error(`Unknown source: ${name}`)
    return sourceTest
  },
  resolveDestination: async (name) => {
    if (name !== 'test') throw new Error(`Unknown destination: ${name}`)
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

const pipeline: PipelineConfig = {
  source: { name: 'test', streams: { customers: {} } },
  destination: { name: 'test' },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let engineServer: any
let engineUrl: string

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serviceServer: any
let serviceUrl: string

beforeAll(async () => {
  // Start engine HTTP server
  const engineApp = createApp(resolver)
  await new Promise<void>((resolve) => {
    engineServer = serve({ fetch: engineApp.fetch, port: 0 }, (info) => {
      engineUrl = `http://localhost:${(info as AddressInfo).port}`
      resolve()
    })
  })

  // Start mock service that returns pipeline config
  const serviceApp = new Hono()
  serviceApp.get('/pipelines/:id', (c) => c.json(pipeline))
  await new Promise<void>((resolve) => {
    serviceServer = serve({ fetch: serviceApp.fetch, port: 0 }, (info) => {
      serviceUrl = `http://localhost:${(info as AddressInfo).port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    engineServer?.close((err: Error | null) => (err ? reject(err) : resolve()))
  })
  await new Promise<void>((resolve, reject) => {
    serviceServer?.close((err: Error | null) => (err ? reject(err) : resolve()))
  })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createActivities (integration via createRemoteEngine)', () => {
  it('setup resolves without error', async () => {
    const activities = createActivities({ serviceUrl, engineUrl })
    await expect(activities.setup('test-pipeline')).resolves.toBeUndefined()
  })

  it('teardown resolves without error', async () => {
    const activities = createActivities({ serviceUrl, engineUrl })
    await expect(activities.teardown('test-pipeline')).resolves.toBeUndefined()
  })

  it('sync returns errors and state', async () => {
    const activities = createActivities({ serviceUrl, engineUrl })
    const result = await activities.sync('test-pipeline', {
      input: [
        { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: 1 },
        { type: 'state', stream: 'customers', data: { cursor: 'cus_1' } },
      ],
    })
    expect(result).toHaveProperty('errors')
    expect(result).toHaveProperty('state')
    expect(Array.isArray(result.errors)).toBe(true)
    // destinationTest echoes state messages back
    expect(result.state).toHaveProperty('customers')
  })

  it('read returns count, records, and state', async () => {
    const activities = createActivities({ serviceUrl, engineUrl })
    const result = await activities.read('test-pipeline', {
      input: [
        { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: 1 },
        { type: 'state', stream: 'customers', data: { cursor: 'cus_1' } },
      ],
    })
    expect(result).toHaveProperty('count')
    expect(result).toHaveProperty('records')
    expect(result).toHaveProperty('state')
    expect(typeof result.count).toBe('number')
    expect(Array.isArray(result.records)).toBe(true)
  })

  it('write returns errors, state, and written count', async () => {
    const activities = createActivities({ serviceUrl, engineUrl })
    const result = await activities.write('test-pipeline', {
      records: [
        { type: 'record', stream: 'customers', data: { id: 'cus_1' }, emitted_at: 1 },
        { type: 'state', stream: 'customers', data: { cursor: 'cus_1' } },
      ],
    })
    expect(result).toHaveProperty('errors')
    expect(result).toHaveProperty('state')
    expect(result).toHaveProperty('written')
    expect(result.written).toBe(2)
    expect(Array.isArray(result.errors)).toBe(true)
  })

  it('sync without input returns empty result', async () => {
    const activities = createActivities({ serviceUrl, engineUrl })
    const result = await activities.sync('test-pipeline')
    expect(result.errors).toEqual([])
    expect(result.state).toEqual({})
  })

  it('write with empty records returns zero written', async () => {
    const activities = createActivities({ serviceUrl, engineUrl })
    const result = await activities.write('test-pipeline', { records: [] })
    expect(result.written).toBe(0)
    expect(result.errors).toEqual([])
  })
})
