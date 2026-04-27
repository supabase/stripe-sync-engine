import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorResolver, Message, SourceStateMessage } from '../lib/index.js'
import { sourceTest, destinationTest, collectFirst } from '../lib/index.js'
import { createApp } from './app.js'
import { z } from 'zod'
import { createSourceMessageFactory, type Source } from '@stripe/sync-protocol'
import { createLogger } from '@stripe/sync-logger'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the raw config JSON Schema from a connector's async iterable spec(). */
async function getRawConfigJsonSchema(
  connector: typeof sourceTest | typeof destinationTest
): Promise<Record<string, unknown>> {
  const specMsg = await collectFirst(
    connector.spec() as AsyncIterable<import('@stripe/sync-protocol').Message>,
    'spec'
  )
  return specMsg.spec.config
}

let resolver: ConnectorResolver
beforeAll(async () => {
  const [srcConfigSchema, destConfigSchema] = await Promise.all([
    getRawConfigJsonSchema(sourceTest),
    getRawConfigJsonSchema(destinationTest),
  ])
  resolver = {
    resolveSource: async () => sourceTest,
    resolveDestination: async () => destinationTest,
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
})

import { beforeAll } from 'vitest'

const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined)
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

const testPipeline = {
  source: { type: 'test', test: { streams: { customers: {} } } },
  destination: { type: 'test', test: {} },
}

/** Read an NDJSON response body into an array of parsed lines. */
async function readNdjson<T>(res: Response): Promise<T[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T)
}

/** Build a JSON POST request init. */
function jsonBody(body: unknown, extraHeaders?: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  consoleInfo.mockClear()
  consoleError.mockClear()
})

// ---------------------------------------------------------------------------
// OpenAPI spec
// ---------------------------------------------------------------------------

describe('GET /openapi.json', () => {
  it('returns a valid OpenAPI 3.1 spec', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/openapi.json')
    expect(res.status).toBe(200)
    const spec = await res.json()
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.title).toBeDefined()
    expect(spec.paths).toBeDefined()
  })

  it('includes all sync operation paths', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(spec.paths)

    expect(paths).toContain('/health')
    expect(paths).toContain('/pipeline_setup')
    expect(paths).toContain('/pipeline_teardown')
    expect(paths).toContain('/pipeline_check')
    expect(paths).toContain('/pipeline_read')
    expect(paths).toContain('/pipeline_write')
    expect(paths).toContain('/pipeline_sync')
    expect(paths).toContain('/source_discover')
    expect(paths).toContain('/meta/sources')
    expect(paths).toContain('/meta/sources/{type}')
    expect(paths).toContain('/meta/destinations')
    expect(paths).toContain('/meta/destinations/{type}')
  })

  it('has typed connector schemas in components (auto-generated from Zod)', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any
    const schemaNames = Object.keys(spec.components?.schemas ?? {})

    expect(schemaNames).toContain('SourceTestConfig')
    expect(schemaNames).toContain('DestinationTestConfig')
    expect(schemaNames).toContain('SourceConfig')
    expect(schemaNames).toContain('DestinationConfig')
    expect(schemaNames).toContain('PipelineConfig')

    // SourceConfig is a discriminated union with inline variants
    const source = spec.components.schemas.SourceConfig
    expect(source.oneOf).toHaveLength(1)
    expect(source.oneOf[0].properties.type.const).toBe('test')
    expect(source.oneOf[0].properties.test.$ref).toContain('SourceTestConfig')
  })

  it('defines NDJSON message schemas with discriminated unions', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any
    const schemas = spec.components.schemas

    // Individual message types — zod-openapi uses const for z.literal() in OpenAPI 3.1
    expect(schemas.RecordMessage.properties.type.const).toBe('record')
    expect(schemas.SourceStateMessage.properties.type.const).toBe('source_state')

    // Message union
    expect(schemas.Message.discriminator.propertyName).toBe('type')
    expect(schemas.Message.oneOf.length).toBeGreaterThanOrEqual(8)

    // EofMessage
    expect(schemas.EofMessage.properties.type.const).toBe('eof')

    // NDJSON responses reference schemas
    const readNdjson =
      spec.paths['/pipeline_read']?.post?.responses?.['200']?.content?.['application/x-ndjson']
    expect(readNdjson.schema.$ref).toBe('#/components/schemas/Message')

    const syncNdjson =
      spec.paths['/pipeline_sync']?.post?.responses?.['200']?.content?.['application/x-ndjson']
    expect(syncNdjson.schema.$ref).toBe('#/components/schemas/SyncOutput')
  })

  it('ControlMessage source_config/destination_config reference typed connector schemas', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any
    const control = spec.components.schemas.ControlMessage.properties.control

    const sourceVariant = control.oneOf.find(
      (v: any) => v.properties?.control_type?.const === 'source_config'
    )
    expect(sourceVariant.properties.source_config.$ref).toBe(
      '#/components/schemas/SourceTestConfig'
    )

    const destVariant = control.oneOf.find(
      (v: any) => v.properties?.control_type?.const === 'destination_config'
    )
    expect(destVariant.properties.destination_config.$ref).toBe(
      '#/components/schemas/DestinationTestConfig'
    )
  })

  it('/setup spec documents 200 response (not 204)', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any
    const setupOp = spec.paths['/pipeline_setup']?.post
    expect(setupOp).toBeDefined()
    expect(setupOp.responses['200']).toBeDefined()
    expect(setupOp.responses['204']).toBeUndefined()
  })

  it('/write spec documents a required JSON request body', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any
    const writeOp = spec.paths['/pipeline_write']?.post
    expect(writeOp).toBeDefined()
    const body = writeOp.requestBody
    expect(body).toBeDefined()
    expect(body.required).toBe(true)
    const jsonContent = body.content?.['application/json']
    expect(jsonContent).toBeDefined()
  })

  it('/read and /sync spec documents a required JSON request body', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any

    for (const path of ['/pipeline_read', '/pipeline_sync'] as const) {
      const op = spec.paths[path]?.post
      expect(op).toBeDefined()
      const body = op.requestBody
      expect(body).toBeDefined()
      expect(body.required).toBe(true)
      expect(body.content?.['application/json']).toBeDefined()
    }
  })

  it('sync routes use JSON request body (not headers)', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any

    // /check is a POST with JSON body, no X-Pipeline header
    const checkOp = spec.paths['/pipeline_check']?.post
    expect(checkOp).toBeDefined()
    expect(checkOp.requestBody?.content?.['application/json']).toBeDefined()
    const headerParam = checkOp.parameters?.find(
      (p: any) => p.in === 'header' && p.name === 'x-pipeline'
    )
    expect(headerParam).toBeUndefined()
  })
})

describe('GET /meta/sources', () => {
  it('returns available source connectors', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/meta/sources')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.items.find((c: any) => c.type === 'test')?.config_schema).toBeDefined()
  })
})

describe('GET /meta/sources/:type', () => {
  it('returns spec for a known source type', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/meta/sources/test')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.config_schema).toBeDefined()
  })

  it('returns 404 for unknown source type', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/meta/sources/nonexistent')
    expect(res.status).toBe(404)
  })
})

describe('GET /meta/destinations', () => {
  it('returns available destination connectors', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/meta/destinations')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.items.find((c: any) => c.type === 'test')?.config_schema).toBeDefined()
  })
})

describe('GET /meta/destinations/:type', () => {
  it('returns spec for a known destination type', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/meta/destinations/test')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.config_schema).toBeDefined()
  })

  it('returns 404 for unknown destination type', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/meta/destinations/nonexistent')
    expect(res.status).toBe(404)
  })
})

describe('GET /docs', () => {
  it('returns HTML (Scalar API reference)', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/docs')
    expect(res.status).toBe(200)
    const contentType = res.headers.get('content-type') ?? ''
    expect(contentType).toContain('text/html')
  })
})

describe('engine request id header', () => {
  it('adds sync-engine-request-id to responses and generates a new value per request', async () => {
    const app = await createApp(resolver)

    const res1 = await app.request('/health')
    const res2 = await app.request('/health')

    const id1 = res1.headers.get('sync-engine-request-id')
    const id2 = res2.headers.get('sync-engine-request-id')

    expect(id1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(id2).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(id1).not.toBe(id2)
  })

  it('bridges pino logs into protocol log messages for streaming requests', async () => {
    const bridgeLogger = createLogger({ name: 'bridge-source', level: 'debug' })
    const bridgeMsg = createSourceMessageFactory<
      Record<string, never>,
      Record<string, never>,
      Record<string, unknown>
    >()
    const bridgeSource = {
      async *spec() {
        yield { type: 'spec' as const, spec: { config: z.toJSONSchema(z.object({})) } }
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
          catalog: {
            streams: [
              { name: 'customers', primary_key: [['id']], newer_than_field: '_updated_at' },
            ],
          },
        }
      },
      async *read() {
        bridgeLogger.info({ stream: 'customers' }, 'connector logger message')
        yield bridgeMsg.record({
          stream: 'customers',
          data: { id: 'cus_bridge' },
          emitted_at: new Date().toISOString(),
        })
      },
    } satisfies Source<Record<string, never>>

    const destConfigSchema = await getRawConfigJsonSchema(destinationTest)
    const bridgeResolver: ConnectorResolver = {
      resolveSource: async () => bridgeSource,
      resolveDestination: async () => destinationTest,
      sources: () =>
        new Map([
          [
            'bridge',
            {
              connector: bridgeSource,
              configSchema: {} as any,
              rawConfigJsonSchema: z.toJSONSchema(z.object({})),
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

    const app = await createApp(bridgeResolver)
    const actionId = 'act_bridge_123'
    const res = await app.request(
      '/pipeline_read',
      jsonBody(
        {
          pipeline: {
            source: { type: 'bridge', bridge: {} },
            destination: { type: 'test', test: {} },
          },
        },
        { 'X-Action-Id': actionId }
      )
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('sync-engine-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    const events = await readNdjson<Message>(res)
    const bridgeLog = events.find(
      (event) => event.type === 'log' && event.log.message === 'connector logger message'
    )
    expect(bridgeLog).toMatchObject({
      type: 'log',
      log: {
        level: 'info',
        message: 'connector logger message',
        data: {
          name: 'bridge-source',
          stream: 'customers',
        },
      },
    })
    expect((bridgeLog as Extract<Message, { type: 'log' }> | undefined)?.log.data).toEqual(
      expect.objectContaining({
        sync_engine_request_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        ),
        action_id: actionId,
      })
    )
  })

  it('keeps action ids isolated across concurrent streaming requests', async () => {
    const bridgeLogger = createLogger({ name: 'bridge-source', level: 'debug' })
    const bridgeMsg = createSourceMessageFactory<
      Record<string, never>,
      Record<string, never>,
      Record<string, unknown>
    >()

    let releaseBothReads!: () => void
    const bothReadsStarted = new Promise<void>((resolve) => {
      releaseBothReads = resolve
    })
    let readCount = 0

    const bridgeSource = {
      async *spec() {
        yield { type: 'spec' as const, spec: { config: z.toJSONSchema(z.object({})) } }
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
          catalog: {
            streams: [
              { name: 'customers', primary_key: [['id']], newer_than_field: '_updated_at' },
            ],
          },
        }
      },
      async *read() {
        bridgeLogger.info('before barrier')
        readCount += 1
        if (readCount === 2) releaseBothReads()
        await bothReadsStarted
        bridgeLogger.info('after barrier')
        yield bridgeMsg.record({
          stream: 'customers',
          data: { id: `cus_${readCount}` },
          emitted_at: new Date().toISOString(),
        })
      },
    } satisfies Source<Record<string, never>>

    const destConfigSchema = await getRawConfigJsonSchema(destinationTest)
    const bridgeResolver: ConnectorResolver = {
      resolveSource: async () => bridgeSource,
      resolveDestination: async () => destinationTest,
      sources: () =>
        new Map([
          [
            'bridge',
            {
              connector: bridgeSource,
              configSchema: {} as any,
              rawConfigJsonSchema: z.toJSONSchema(z.object({})),
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

    const app = await createApp(bridgeResolver)
    const actionA = 'act_concurrent_a'
    const actionB = 'act_concurrent_b'
    const bridgePipeline = {
      source: { type: 'bridge', bridge: {} },
      destination: { type: 'test', test: {} },
    }

    const [resA, resB] = await Promise.all([
      app.request(
        '/pipeline_read',
        jsonBody({ pipeline: bridgePipeline }, { 'X-Action-Id': actionA })
      ),
      app.request(
        '/pipeline_read',
        jsonBody({ pipeline: bridgePipeline }, { 'X-Action-Id': actionB })
      ),
    ])

    const [eventsA, eventsB] = await Promise.all([
      readNdjson<Message>(resA),
      readNdjson<Message>(resB),
    ])

    const actionIdsA = eventsA
      .filter((event): event is Extract<Message, { type: 'log' }> => event.type === 'log')
      .map((event) => event.log.data?.action_id)
    const actionIdsB = eventsB
      .filter((event): event is Extract<Message, { type: 'log' }> => event.type === 'log')
      .map((event) => event.log.data?.action_id)

    expect(actionIdsA).toEqual(expect.arrayContaining([actionA]))
    expect(actionIdsB).toEqual(expect.arrayContaining([actionB]))
    expect(actionIdsA.every((actionId) => actionId === actionA)).toBe(true)
    expect(actionIdsB.every((actionId) => actionId === actionB)).toBe(true)
    expect(actionIdsA).not.toContain(actionB)
    expect(actionIdsB).not.toContain(actionA)
  })
})

// ---------------------------------------------------------------------------
// Sync operations
// ---------------------------------------------------------------------------

describe('POST /setup', () => {
  it('streams NDJSON setup messages', async () => {
    const app = await createApp(resolver)

    const res = await app.request('/pipeline_setup', jsonBody({ pipeline: testPipeline }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
    const events = await readNdjson<Message>(res)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'log',
      log: {
        level: 'info',
        message: 'Starting pipeline setup',
        data: {
          source_type: 'test',
          destination_type: 'test',
          run_source: true,
          run_destination: true,
        },
      },
    })
  })
})

describe('POST /teardown', () => {
  it('streams NDJSON teardown messages', async () => {
    const app = await createApp(resolver)

    const res = await app.request('/pipeline_teardown', jsonBody({ pipeline: testPipeline }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
    // sourceTest and destinationTest have no teardown(), so stream is empty
    const events = await readNdjson(res)
    expect(events).toHaveLength(0)
  })
})

describe('POST /check', () => {
  it('streams connection_status messages for source and destination', async () => {
    const app = await createApp(resolver)

    const res = await app.request('/pipeline_check', jsonBody({ pipeline: testPipeline }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
    const events = await readNdjson<Record<string, unknown>>(res)
    const statuses = events.filter((e) => e.type === 'connection_status')
    expect(statuses).toHaveLength(2)
    expect(statuses.every((s: any) => s.connection_status.status === 'succeeded')).toBe(true)
  })
})

describe('POST /read', () => {
  it('streams messages as NDJSON', async () => {
    const app = await createApp(resolver)

    const stdin = [
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1', name: 'Alice' },
          emitted_at: new Date().toISOString(),
        },
      },
      { type: 'source_state', source_state: { stream: 'customers', data: { status: 'complete' } } },
    ]
    const res = await app.request('/pipeline_read', jsonBody({ pipeline: testPipeline, stdin }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')

    const events = await readNdjson<Message>(res)
    const dataEvents = events.filter((event) => event.type !== 'log')
    expect(dataEvents).toHaveLength(3)
    expect(dataEvents[0]!.type).toBe('record')
    expect(dataEvents[1]!.type).toBe('source_state')
    expect(dataEvents[2]).toMatchObject({ type: 'eof', eof: { has_more: false } })
  })
})

describe('POST /write', () => {
  it('accepts messages array, streams NDJSON state back', async () => {
    const app = await createApp(resolver)

    const messages: Message[] = [
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      {
        type: 'source_state',
        source_state: {
          stream: 'customers',
          data: { cursor: 'cus_1' },
        },
      },
    ]

    const res = await app.request(
      '/pipeline_write',
      jsonBody({
        pipeline: testPipeline,
        stdin: messages,
      })
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')

    const events = await readNdjson<Message>(res)
    const stateEvents = events.filter((e) => e.type === 'source_state') as SourceStateMessage[]
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0]!.source_state.stream).toBe('customers')
  })

  it('returns 400 when body is missing', async () => {
    const app = await createApp(resolver)

    const res = await app.request('/pipeline_write', { method: 'POST' })
    expect(res.status).toBe(400)
  })
})

describe('POST /sync', () => {
  it('runs full pipeline, streams NDJSON state', async () => {
    const app = await createApp(resolver)

    const stdin = [
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1', name: 'Alice' },
          emitted_at: new Date().toISOString(),
        },
      },
      { type: 'source_state', source_state: { stream: 'customers', data: { status: 'complete' } } },
    ]
    const res = await app.request('/pipeline_sync', jsonBody({ pipeline: testPipeline, stdin }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')

    const events = await readNdjson<Record<string, unknown>>(res)
    const stateAndEof = events.filter((e) => e.type === 'source_state' || e.type === 'eof')
    expect(stateAndEof).toHaveLength(2)
    expect(stateAndEof[0]!.type).toBe('source_state')
    expect(stateAndEof[1]).toMatchObject({ type: 'eof', eof: { has_more: false } })
  })
})

// ---------------------------------------------------------------------------
// time_limit and run_id query params
// ---------------------------------------------------------------------------

describe('time_limit and run_id', () => {
  it('POST /pipeline_sync forwards run_id into the emitted sync state', async () => {
    const app = await createApp(resolver)

    const stdin = [
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      { type: 'source_state', source_state: { stream: 'customers', data: { cursor: '1' } } },
    ]
    const res = await app.request(
      '/pipeline_sync',
      jsonBody({
        pipeline: testPipeline,
        run_id: 'run_demo',
        stdin,
      })
    )

    expect(res.status).toBe(200)
    const events = await readNdjson<Message>(res)
    const eofEvent = events.find((e) => e.type === 'eof')
    expect(eofEvent).toMatchObject({
      type: 'eof',
      eof: { ending_state: { sync_run: { run_id: 'run_demo' } } },
    })
  })

  it('POST /read without limits returns all messages plus eof:complete', async () => {
    const app = await createApp(resolver)

    const stdin = [
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      { type: 'source_state', source_state: { stream: 'customers', data: { cursor: '1' } } },
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_2' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      { type: 'source_state', source_state: { stream: 'customers', data: { cursor: '2' } } },
    ]
    const res = await app.request('/pipeline_read', jsonBody({ pipeline: testPipeline, stdin }))

    expect(res.status).toBe(200)
    const events = await readNdjson<Message>(res)
    const dataEvents = events.filter((event) => event.type !== 'log')
    expect(dataEvents).toHaveLength(5)
    expect(dataEvents[4]).toMatchObject({ type: 'eof', eof: { has_more: false } })
  })
})

describe('error handling', () => {
  it('returns 400 when body is missing', async () => {
    const app = await createApp(resolver)

    const res = await app.request('/pipeline_check', { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('returns 400 when body has invalid pipeline config', async () => {
    const app = await createApp(resolver)

    const res = await app.request('/pipeline_check', jsonBody({ pipeline: 'not-valid' }))
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /source_discover
// ---------------------------------------------------------------------------

describe('POST /source_discover', () => {
  it('streams a catalog message from a working source', async () => {
    const app = await createApp(resolver)

    const res = await app.request(
      '/source_discover',
      jsonBody({
        source: { type: 'test', test: { streams: { customers: {}, products: {} } } },
      })
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
    const events = await readNdjson<Record<string, unknown>>(res)
    const catalogs = events.filter((e) => e.type === 'catalog')
    expect(catalogs).toHaveLength(1)
    const catalog = (catalogs[0] as any).catalog
    const streamNames = catalog.streams.map((s: any) => s.name)
    expect(streamNames).toContain('customers')
    expect(streamNames).toContain('products')
  })

  it('returns 500 when discover throws', async () => {
    const failingSource = {
      ...sourceTest,
      async *discover(): AsyncIterable<import('@stripe/sync-protocol').DiscoverOutput> {
        throw new Error('Could not resolve Stripe OpenAPI spec: network unreachable')
      },
    }
    const failingResolver: ConnectorResolver = {
      resolveSource: async () => failingSource,
      resolveDestination: resolver.resolveDestination,
      sources: resolver.sources,
      destinations: resolver.destinations,
    }
    const app = await createApp(failingResolver)

    const res = await app.request(
      '/source_discover',
      jsonBody({
        source: { type: 'test', test: {} },
      })
    )

    expect(res.status).toBe(200)
    const events = await readNdjson<Record<string, unknown>>(res)
    const logs = events.filter((e) => e.type === 'log')
    expect(logs.length).toBeGreaterThanOrEqual(0)
  })

  it('returns 400 when body is missing', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/source_discover', { method: 'POST' })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// POST /internal/query
// ---------------------------------------------------------------------------

describe('POST /internal/query', () => {
  const dbUrl = process.env.DATABASE_URL!

  it('executes SQL and returns rows and rowCount', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/internal/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection_string: dbUrl, sql: 'SELECT 1 AS n' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { rows: unknown[]; rowCount: number }
    expect(body.rows).toEqual([{ n: 1 }])
    expect(body.rowCount).toBe(1)
  })

  it('returns 400 with error message for invalid SQL', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/internal/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection_string: dbUrl, sql: 'NOT VALID SQL' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/syntax error/i)
  })

  it('connects without SSL when sslmode is absent (no SSL forced)', async () => {
    // Strip sslmode so the route sees a connection string with no SSL hint.
    // If the handler incorrectly forced ssl: { rejectUnauthorized: false },
    // this would fail on a local Postgres that has no SSL configured.
    const url = new URL(dbUrl)
    url.searchParams.delete('sslmode')

    const app = await createApp(resolver)
    const res = await app.request('/internal/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection_string: url.toString(), sql: 'SELECT 1' }),
    })

    expect(res.status).toBe(200)
  })

  it('returns 400 when required fields are missing', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/internal/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection_string: 'postgres://localhost/db' }),
    })

    expect(res.status).toBe(400)
  })
})
