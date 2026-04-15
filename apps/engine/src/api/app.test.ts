import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorResolver, Message, SourceStateMessage } from '../lib/index.js'
import { sourceTest, destinationTest, collectFirst } from '../lib/index.js'
import { createApp } from './app.js'

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

const syncParams = JSON.stringify({
  source: { type: 'test', test: { streams: { customers: {} } } },
  destination: { type: 'test', test: {} },
})

/** Read an NDJSON response body into an array of parsed lines. */
async function readNdjson<T>(res: Response): Promise<T[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T)
}

/** Build NDJSON string from array of objects. */
function toNdjson(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n')
}

/** Headers for a request body: Content-Type + Content-Length (required for hasBody()). */
function bodyHeaders(body: string): Record<string, string> {
  return {
    'Content-Type': 'application/x-ndjson',
    'Content-Length': String(new TextEncoder().encode(body).length),
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
    expect(schemas.TraceMessage.properties.type.const).toBe('trace')

    // Message union
    expect(schemas.Message.discriminator.propertyName).toBe('type')
    // 9 message types: record, state, catalog, log, trace, spec, connection_status, control, eof
    expect(schemas.Message.oneOf.length).toBeGreaterThanOrEqual(9)

    // DestinationOutput union (state, trace, log, eof)
    expect(schemas.DestinationOutput.discriminator.propertyName).toBe('type')
    expect(schemas.DestinationOutput.oneOf).toHaveLength(4)

    // EofMessage
    expect(schemas.EofMessage.properties.type.const).toBe('eof')

    // NDJSON responses reference schemas (zod-openapi adds Output suffix for response-only types)
    const readNdjson =
      spec.paths['/pipeline_read']?.post?.responses?.['200']?.content?.['application/x-ndjson']
    expect(readNdjson.schema.$ref).toBe('#/components/schemas/Message')

    const writeNdjson =
      spec.paths['/pipeline_write']?.post?.responses?.['200']?.content?.['application/x-ndjson']
    expect(writeNdjson.schema.$ref).toBe('#/components/schemas/DestinationOutput')

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

  it('/write spec documents a required NDJSON request body', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any
    const writeOp = spec.paths['/pipeline_write']?.post
    expect(writeOp).toBeDefined()
    const body = writeOp.requestBody
    expect(body).toBeDefined()
    expect(body.required).toBe(true)
    const ndjsonContent = body.content?.['application/x-ndjson']
    expect(ndjsonContent).toBeDefined()
    expect(ndjsonContent.schema.$ref).toBe('#/components/schemas/Message')
  })

  it('/read and /sync spec documents an optional NDJSON request body', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any

    for (const path of ['/pipeline_read', '/pipeline_sync'] as const) {
      const op = spec.paths[path]?.post
      expect(op).toBeDefined()
      const body = op.requestBody
      expect(body).toBeDefined()
      expect(body.required).toBe(false)
      expect(body.content?.['application/x-ndjson']).toBeDefined()
    }
  })

  it('documents the X-Pipeline header on sync routes', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any

    // /check is a POST with X-Pipeline header
    const checkOp = spec.paths['/pipeline_check']?.post
    expect(checkOp).toBeDefined()
    const headerParam = checkOp.parameters?.find(
      (p: any) => p.in === 'header' && p.name === 'x-pipeline'
    )
    expect(headerParam).toBeDefined()
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

// ---------------------------------------------------------------------------
// Sync operations
// ---------------------------------------------------------------------------

describe('POST /setup', () => {
  it('streams NDJSON setup messages', async () => {
    const app = await createApp(resolver)

    const res = await app.request('/pipeline_setup', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
    // sourceTest and destinationTest have no setup(), so stream is empty
    const events = await readNdjson(res)
    expect(events).toHaveLength(0)
  })
})

describe('POST /teardown', () => {
  it('streams NDJSON teardown messages', async () => {
    const app = await createApp(resolver)

    const res = await app.request('/pipeline_teardown', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams },
    })
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

    const res = await app.request('/pipeline_check', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams },
    })
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

    const body = toNdjson([
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1', name: 'Alice' },
          emitted_at: new Date().toISOString(),
        },
      },
      { type: 'source_state', source_state: { stream: 'customers', data: { status: 'complete' } } },
    ])
    const res = await app.request('/pipeline_read', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams, ...bodyHeaders(body) },
      body,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')

    const events = await readNdjson<Message>(res)
    expect(events).toHaveLength(3)
    expect(events[0]!.type).toBe('record')
    expect(events[1]!.type).toBe('source_state')
    expect(events[2]).toMatchObject({ type: 'eof', eof: { reason: 'complete' } })
  })

  describe('SourceInputMessage validation (source with input schema)', () => {
    // Build a resolver where the source has rawInputJsonSchema.
    // The input schema matches the Message record shape so sourceTest can echo it
    // and the engine's Message.parse() succeeds downstream.
    let inputApp: Awaited<ReturnType<typeof createApp>>
    const inputSchema = {
      type: 'object',
      properties: {
        type: { type: 'string' },
        record: { type: 'object' },
        state: { type: 'object' },
      },
      required: ['type'],
    }

    beforeAll(async () => {
      const [srcConfigSchema, destConfigSchema] = await Promise.all([
        getRawConfigJsonSchema(sourceTest),
        getRawConfigJsonSchema(destinationTest),
      ])
      const inputResolver: ConnectorResolver = {
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
                rawInputJsonSchema: inputSchema,
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
      inputApp = await createApp(inputResolver)
    })

    it('spec uses SourceInputMessage schema for /read and /sync request body when source has input schema', async () => {
      const res = await inputApp.request('/openapi.json')
      const spec = (await res.json()) as any

      for (const path of ['/pipeline_read', '/pipeline_sync'] as const) {
        const body = spec.paths[path]?.post?.requestBody
        expect(body).toBeDefined()
        expect(body.required).toBe(false)
        expect(body.content?.['application/x-ndjson']?.schema?.$ref).toBe(
          '#/components/schemas/SourceInputMessage'
        )
      }
    })

    it('accepts valid wrapped input and passes unwrapped data to source', async () => {
      const record = {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: new Date().toISOString(),
        },
      }
      const body = toNdjson([{ type: 'source_input', source_input: record }])
      const res = await inputApp.request('/pipeline_read', {
        method: 'POST',
        headers: { 'X-Pipeline': syncParams, ...bodyHeaders(body) },
        body,
      })
      expect(res.status).toBe(200)
      const events = await readNdjson<Message>(res)
      // sourceTest echoes the unwrapped record, engine parses it as Message
      expect(events.some((e) => e.type === 'record')).toBe(true)
    })

    it('rejects input that fails the SourceInputMessage schema', async () => {
      // Missing required 'type' field in the inner payload
      const body = toNdjson([{ type: 'source_input', source_input: { noTypeField: true } }])
      const res = await inputApp.request('/pipeline_read', {
        method: 'POST',
        headers: { 'X-Pipeline': syncParams, ...bodyHeaders(body) },
        body,
      })
      // SourceInputMessage.parse() throws — error propagates through the NDJSON stream
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain('error')
    })

    it('pipeline_sync: accepts raw (already-unwrapped) input and produces output', async () => {
      // pipeline_sync passes input as-is to engine — no SourceInputMessage unwrapping in the handler.
      // Clients send the connector-specific payload directly (not the SourceInputMessage envelope).
      const body = toNdjson([
        {
          type: 'record',
          record: {
            stream: 'customers',
            data: { id: 'cus_1' },
            emitted_at: new Date().toISOString(),
          },
        },
        { type: 'source_state', source_state: { stream: 'customers', data: {} } },
      ])
      const res = await inputApp.request('/pipeline_sync', {
        method: 'POST',
        headers: { 'X-Pipeline': syncParams, ...bodyHeaders(body) },
        body,
      })
      expect(res.status).toBe(200)
      const events = await readNdjson<Record<string, unknown>>(res)
      expect(events.some((e) => e.type === 'source_state' || e.type === 'eof')).toBe(true)
    })
  })
})

describe('POST /write', () => {
  it('accepts NDJSON records, streams NDJSON state back', async () => {
    const app = await createApp(resolver)

    const records: Message[] = [
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

    const writeBody = toNdjson(records)
    const res = await app.request('/pipeline_write', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams, ...bodyHeaders(writeBody) },
      body: writeBody,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')

    const events = await readNdjson<SourceStateMessage>(res)
    // destinationTest passes through source_state messages only
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('source_state')
    expect((events[0] as SourceStateMessage).source_state.stream).toBe('customers')
  })

  it('returns 400 when body is missing', async () => {
    const app = await createApp(resolver)

    const res = await app.request('/pipeline_write', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('body required')
  })
})

describe('POST /sync', () => {
  it('runs full pipeline, streams NDJSON state', async () => {
    const app = await createApp(resolver)

    const runBody = toNdjson([
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1', name: 'Alice' },
          emitted_at: new Date().toISOString(),
        },
      },
      { type: 'source_state', source_state: { stream: 'customers', data: { status: 'complete' } } },
    ])
    const res = await app.request('/pipeline_sync', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams, ...bodyHeaders(runBody) },
      body: runBody,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')

    const events = await readNdjson<Record<string, unknown>>(res)
    // pipeline_sync now yields source signals alongside dest output
    const stateAndEof = events.filter((e) => e.type === 'source_state' || e.type === 'eof')
    expect(stateAndEof).toHaveLength(2)
    expect(stateAndEof[0]!.type).toBe('source_state')
    expect(stateAndEof[1]).toMatchObject({ type: 'eof', eof: { reason: 'complete' } })
  })
})

// ---------------------------------------------------------------------------
// state_limit and time_limit query params
// ---------------------------------------------------------------------------

describe('state_limit and time_limit', () => {
  it('POST /pipeline_sync accepts deprecated X-Source-State header', async () => {
    const app = await createApp(resolver)

    const body = toNdjson([
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_1' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
      { type: 'source_state', source_state: { stream: 'customers', data: { cursor: '1' } } },
    ])
    const res = await app.request('/pipeline_sync?state_limit=1', {
      method: 'POST',
      headers: {
        'X-Pipeline': syncParams,
        'X-Source-State': JSON.stringify({ streams: { customers: { cursor: '0' } }, global: {} }),
        ...bodyHeaders(body),
      },
      body,
    })

    expect(res.status).toBe(200)
    const events = await readNdjson<Message>(res)
    expect(events.some((e) => e.type === 'eof')).toBe(true)
  })

  it('POST /pipeline_read?state_limit=1 stops after 1 state message and emits eof', async () => {
    const app = await createApp(resolver)

    const body = toNdjson([
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
      {
        type: 'record',
        record: {
          stream: 'customers',
          data: { id: 'cus_3' },
          emitted_at: '2024-01-01T00:00:00.000Z',
        },
      },
    ])
    const res = await app.request('/pipeline_read?state_limit=1', {
      method: 'POST',
      headers: {
        'X-Pipeline': syncParams,
        ...bodyHeaders(body),
      },
      body,
    })

    expect(res.status).toBe(200)
    const events = await readNdjson<Message>(res)
    // 1 record + 1 state + 1 eof
    expect(events).toHaveLength(3)
    expect(events[0]!.type).toBe('record')
    expect(events[1]!.type).toBe('source_state')
    expect(events[2]).toMatchObject({ type: 'eof', eof: { reason: 'state_limit' } })
  })

  it('POST /pipeline_sync?state_limit=1 stops after 1 state message and emits eof', async () => {
    const app = await createApp(resolver)

    const body = toNdjson([
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
    ])
    const res = await app.request('/pipeline_sync?state_limit=1', {
      method: 'POST',
      headers: {
        'X-Pipeline': syncParams,
        ...bodyHeaders(body),
      },
      body,
    })

    expect(res.status).toBe(200)
    const events = await readNdjson<Message>(res)
    const stateEvents = events.filter((e) => e.type === 'source_state')
    const eofEvents = events.filter((e) => e.type === 'eof')
    expect(stateEvents).toHaveLength(1)
    expect(eofEvents).toHaveLength(1)
    expect(eofEvents[0]).toMatchObject({ type: 'eof', eof: { reason: 'state_limit' } })
  })

  it('POST /read without limits returns all messages plus eof:complete', async () => {
    const app = await createApp(resolver)

    const body = toNdjson([
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
    ])
    const res = await app.request('/pipeline_read', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams, ...bodyHeaders(body) },
      body,
    })

    expect(res.status).toBe(200)
    const events = await readNdjson<Message>(res)
    // 4 original messages + eof
    expect(events).toHaveLength(5)
    expect(events[4]).toMatchObject({ type: 'eof', eof: { reason: 'complete' } })
  })
})

describe('error handling', () => {
  it('returns 400 when X-Pipeline header is missing', async () => {
    const app = await createApp(resolver)

    const res = await app.request('/pipeline_check', { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('returns 400 when X-Pipeline header is invalid JSON', async () => {
    const app = await createApp(resolver)

    const res = await app.request('/pipeline_check', {
      method: 'POST',
      headers: { 'X-Pipeline': 'not-json' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    // Zod transform issues are returned as an array from the defaultHook
    expect(body.error).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: 'Invalid JSON' })])
    )
  })
})

// ---------------------------------------------------------------------------
// POST /source_discover
// ---------------------------------------------------------------------------

describe('POST /source_discover', () => {
  it('streams a catalog message from a working source', async () => {
    const app = await createApp(resolver)
    const source = JSON.stringify({
      type: 'test',
      test: { streams: { customers: {}, products: {} } },
    })

    const res = await app.request('/source_discover', {
      method: 'POST',
      headers: { 'X-Source': source },
    })

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

  it('emits a trace error message when discover throws instead of silently closing', async () => {
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

    const res = await app.request('/source_discover', {
      method: 'POST',
      headers: { 'X-Source': JSON.stringify({ type: 'test', test: {} }) },
    })

    expect(res.status).toBe(200)
    const events = await readNdjson<Record<string, unknown>>(res)
    const traces = events.filter((e) => e.type === 'trace')
    expect(traces).toHaveLength(1)
    const trace = (traces[0] as any).trace
    expect(trace.trace_type).toBe('error')
    expect(trace.error.failure_type).toBe('system_error')
    expect(trace.error.message).toContain('network unreachable')
  })

  it('returns 400 when X-Source header is missing', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/source_discover', { method: 'POST' })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// JSON body mode (Content-Type: application/json)
// ---------------------------------------------------------------------------

const syncParamsObj = JSON.parse(syncParams)

describe('JSON body mode', () => {
  it('POST /pipeline_check accepts pipeline in JSON body', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/pipeline_check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline: syncParamsObj }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
    const events = await readNdjson<Record<string, unknown>>(res)
    const statuses = events.filter((e) => e.type === 'connection_status')
    expect(statuses).toHaveLength(2)
  })

  it('POST /pipeline_setup accepts pipeline in JSON body', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/pipeline_setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline: syncParamsObj }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
  })

  it('POST /pipeline_teardown accepts pipeline in JSON body', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/pipeline_teardown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline: syncParamsObj }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')
  })

  it('POST /source_discover accepts source in JSON body', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/source_discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'test', test: { streams: { customers: {} } } },
      }),
    })
    expect(res.status).toBe(200)
    const events = await readNdjson<Record<string, unknown>>(res)
    expect(events.some((e) => e.type === 'catalog')).toBe(true)
  })

  it('POST /pipeline_read accepts pipeline + state + body array in JSON body', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/pipeline_read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipeline: syncParamsObj,
        body: [
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_1', name: 'Alice' },
              emitted_at: new Date().toISOString(),
            },
          },
          {
            type: 'source_state',
            source_state: { stream: 'customers', data: { status: 'complete' } },
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const events = await readNdjson<Message>(res)
    expect(events).toHaveLength(3)
    expect(events[0]!.type).toBe('record')
    expect(events[1]!.type).toBe('source_state')
    expect(events[2]).toMatchObject({ type: 'eof', eof: { reason: 'complete' } })
  })

  it('POST /pipeline_read accepts pipeline in JSON body without input', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/pipeline_read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline: syncParamsObj }),
    })
    expect(res.status).toBe(200)
    const events = await readNdjson<Message>(res)
    expect(events.some((e) => e.type === 'eof')).toBe(true)
  })

  it('POST /pipeline_write accepts pipeline + body array in JSON body', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/pipeline_write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipeline: syncParamsObj,
        body: [
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
            source_state: { stream: 'customers', data: { cursor: 'cus_1' } },
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const events = await readNdjson<Record<string, unknown>>(res)
    expect(events.some((e) => e.type === 'source_state')).toBe(true)
  })

  it('POST /pipeline_sync accepts pipeline + state + body array in JSON body', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/pipeline_sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pipeline: syncParamsObj,
        body: [
          {
            type: 'record',
            record: {
              stream: 'customers',
              data: { id: 'cus_1', name: 'Alice' },
              emitted_at: new Date().toISOString(),
            },
          },
          {
            type: 'source_state',
            source_state: { stream: 'customers', data: { status: 'complete' } },
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const events = await readNdjson<Record<string, unknown>>(res)
    expect(events.some((e) => e.type === 'source_state')).toBe(true)
    expect(events.some((e) => e.type === 'eof')).toBe(true)
  })

  it('POST /pipeline_sync without body array runs backfill mode', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/pipeline_sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline: syncParamsObj }),
    })
    expect(res.status).toBe(200)
    const events = await readNdjson<Record<string, unknown>>(res)
    expect(events.some((e) => e.type === 'eof')).toBe(true)
  })

  it('returns 400 when JSON body is missing pipeline', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/pipeline_check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('NDJSON content-type uses header mode even with JSON-like body', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/pipeline_check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        'X-Pipeline': syncParams,
      },
    })
    expect(res.status).toBe(200)
  })

  it('no content-type defaults to header mode', async () => {
    const app = await createApp(resolver)
    const res = await app.request('/pipeline_check', {
      method: 'POST',
      headers: { 'X-Pipeline': syncParams },
    })
    expect(res.status).toBe(200)
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
