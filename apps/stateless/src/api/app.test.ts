import { describe, expect, it } from 'vitest'
import type { ConnectorResolver, Message, StateMessage } from '@stripe/stateless-sync'
import { testSource, testDestination } from '@stripe/stateless-sync'
import { createApp } from './app'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const resolver: ConnectorResolver = {
  resolveSource: async () => testSource,
  resolveDestination: async () => testDestination,
}

const syncParams = JSON.stringify({
  source_name: 'test',
  destination_name: 'test',
  source_config: { streams: { customers: {} } },
  destination_config: {},
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

// ---------------------------------------------------------------------------
// Tests
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

    const res = await app.request('/read', {
      method: 'POST',
      headers: { 'X-Sync-Params': syncParams, 'Content-Type': 'application/x-ndjson' },
      body: toNdjson([
        {
          type: 'record',
          stream: 'customers',
          data: { id: 'cus_1', name: 'Alice' },
          emitted_at: Date.now(),
        },
        { type: 'state', stream: 'customers', data: { status: 'complete' } },
      ]),
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

    const res = await app.request('/write', {
      method: 'POST',
      headers: {
        'X-Sync-Params': syncParams,
        'Content-Type': 'application/x-ndjson',
      },
      body: toNdjson(records),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson')

    const events = await readNdjson<StateMessage>(res)
    // testDestination passes through state messages only
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

describe('POST /run', () => {
  it('runs full pipeline, streams NDJSON state', async () => {
    const app = createApp(resolver)

    const res = await app.request('/run', {
      method: 'POST',
      headers: { 'X-Sync-Params': syncParams, 'Content-Type': 'application/x-ndjson' },
      body: toNdjson([
        {
          type: 'record',
          stream: 'customers',
          data: { id: 'cus_1', name: 'Alice' },
          emitted_at: Date.now(),
        },
        { type: 'state', stream: 'customers', data: { status: 'complete' } },
      ]),
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
