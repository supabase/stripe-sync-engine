import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorResolver, Message, StateMessage } from '../lib/index.js'
import { sourceTest, destinationTest } from '../lib/index.js'
import { createApp } from './app.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resolver: ConnectorResolver = {
  resolveSource: async () => sourceTest,
  resolveDestination: async () => destinationTest,
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
const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined)
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

const syncParams = JSON.stringify({
  source: { name: 'test', streams: { customers: {} } },
  destination: { name: 'test' },
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
  it('returns a valid OpenAPI 3.0 spec', async () => {
    const app = createApp(resolver)
    const res = await app.request('/openapi.json')
    expect(res.status).toBe(200)
    const spec = await res.json()
    expect(spec.openapi).toBe('3.0.0')
    expect(spec.info.title).toBeDefined()
    expect(spec.paths).toBeDefined()
  })

  it('includes all sync operation paths', async () => {
    const app = createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as { paths: Record<string, unknown> }
    const paths = Object.keys(spec.paths)

    expect(paths).toContain('/health')
    expect(paths).toContain('/setup')
    expect(paths).toContain('/teardown')
    expect(paths).toContain('/check')
    expect(paths).toContain('/read')
    expect(paths).toContain('/write')
    expect(paths).toContain('/sync')
    expect(paths).toContain('/connectors')
  })

  it('injects typed connector schemas into components', async () => {
    const app = createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any
    const schemaNames = Object.keys(spec.components?.schemas ?? {})

    expect(schemaNames).toContain('TestSourceConfig')
    expect(schemaNames).toContain('TestDestinationConfig')
    expect(schemaNames).toContain('SourceConfig')
    expect(schemaNames).toContain('DestinationConfig')
    expect(schemaNames).toContain('SyncParams')

    // SourceConfig is a discriminated union
    expect(spec.components.schemas.SourceConfig.discriminator.propertyName).toBe('name')
    expect(spec.components.schemas.SourceConfig.oneOf).toHaveLength(1)

    // Each variant has name as required field
    const testSource = spec.components.schemas.TestSourceConfig
    expect(testSource.required).toContain('name')
    expect(testSource.properties.name.enum).toEqual(['test'])
  })

  it('documents the X-Sync-Params header on sync routes', async () => {
    const app = createApp(resolver)
    const res = await app.request('/openapi.json')
    const spec = (await res.json()) as any

    // /check is a GET with X-Sync-Params header
    const checkOp = spec.paths['/check']?.get
    expect(checkOp).toBeDefined()
    const headerParam = checkOp.parameters?.find(
      (p: any) => p.in === 'header' && p.name === 'x-sync-params'
    )
    expect(headerParam).toBeDefined()
  })
})

describe('GET /connectors', () => {
  it('returns available connectors with config schemas', async () => {
    const app = createApp(resolver)
    const res = await app.request('/connectors')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.sources).toHaveProperty('test')
    expect(body.destinations).toHaveProperty('test')
    expect(body.sources.test.config_schema).toBeDefined()
  })
})

describe('GET /docs', () => {
  it('returns HTML (Scalar API reference)', async () => {
    const app = createApp(resolver)
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
  it('returns 204', async () => {
    const app = createApp(resolver)

    const res = await app.request('/setup', {
      method: 'POST',
      headers: { 'X-Sync-Params': syncParams },
    })
    expect(res.status).toBe(204)
  })
})

describe('POST /teardown', () => {
  it('returns 204', async () => {
    const app = createApp(resolver)

    const res = await app.request('/teardown', {
      method: 'POST',
      headers: { 'X-Sync-Params': syncParams },
    })
    expect(res.status).toBe(204)
  })
})

describe('GET /check', () => {
  it('returns source and destination check results', async () => {
    const app = createApp(resolver)

    const res = await app.request('/check', {
      headers: { 'X-Sync-Params': syncParams },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      source: { status: 'succeeded' },
      destination: { status: 'succeeded' },
    })
  })
})

describe('POST /read', () => {
  it('streams messages as NDJSON', async () => {
    const app = createApp(resolver)

    const body = toNdjson([
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1', name: 'Alice' },
        emitted_at: Date.now(),
      },
      { type: 'state', stream: 'customers', data: { status: 'complete' } },
    ])
    const res = await app.request('/read', {
      method: 'POST',
      headers: { 'X-Sync-Params': syncParams, ...bodyHeaders(body) },
      body,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')

    const events = await readNdjson<Message>(res)
    expect(events).toHaveLength(2)
    expect(events[0]!.type).toBe('record')
    expect(events[1]!.type).toBe('state')
  })
})

describe('POST /write', () => {
  it('accepts NDJSON records, streams NDJSON state back', async () => {
    const app = createApp(resolver)

    const records: Message[] = [
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1' },
        emitted_at: 1000,
      },
      {
        type: 'state',
        stream: 'customers',
        data: { cursor: 'cus_1' },
      },
    ]

    const writeBody = toNdjson(records)
    const res = await app.request('/write', {
      method: 'POST',
      headers: { 'X-Sync-Params': syncParams, ...bodyHeaders(writeBody) },
      body: writeBody,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')

    const events = await readNdjson<StateMessage>(res)
    // destinationTest passes through state messages only
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('state')
    expect(events[0]!.stream).toBe('customers')
  })

  it('returns 400 when body is missing', async () => {
    const app = createApp(resolver)

    const res = await app.request('/write', {
      method: 'POST',
      headers: { 'X-Sync-Params': syncParams },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('body required')
  })
})

describe('POST /sync', () => {
  it('runs full pipeline, streams NDJSON state', async () => {
    const app = createApp(resolver)

    const runBody = toNdjson([
      {
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1', name: 'Alice' },
        emitted_at: Date.now(),
      },
      { type: 'state', stream: 'customers', data: { status: 'complete' } },
    ])
    const res = await app.request('/sync', {
      method: 'POST',
      headers: { 'X-Sync-Params': syncParams, ...bodyHeaders(runBody) },
      body: runBody,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')

    const events = await readNdjson<StateMessage>(res)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('state')
  })
})

describe('error handling', () => {
  it('returns 400 when X-Sync-Params header is missing', async () => {
    const app = createApp(resolver)

    const res = await app.request('/check')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Missing X-Sync-Params')
  })

  it('returns 400 when X-Sync-Params header is invalid JSON', async () => {
    const app = createApp(resolver)

    const res = await app.request('/check', {
      headers: { 'X-Sync-Params': 'not-json' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid JSON')
  })
})
