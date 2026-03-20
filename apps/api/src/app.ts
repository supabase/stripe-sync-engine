import { Hono } from 'hono'
import type { ConnectorResolver, SyncParams, Message } from '@stripe/sync-protocol'
import { createEngine } from '@stripe/sync-protocol'
import { parseNdjson, sseResponse } from './stream'

export function createApp(resolver: ConnectorResolver) {
  const app = new Hono()

  /** Parse X-Sync-Params header or return a 400 Response. */
  function parseSyncParams(header: string | undefined): SyncParams | Response {
    if (!header) {
      return new Response(JSON.stringify({ error: 'Missing X-Sync-Params header' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    try {
      return JSON.parse(header) as SyncParams
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON in X-Sync-Params header' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  /** Resolve connectors from SyncParams and create an engine. */
  async function resolveEngine(params: SyncParams) {
    const [source, destination] = await Promise.all([
      resolver.resolveSource(params.source),
      resolver.resolveDestination(params.destination),
    ])
    return createEngine(params, { source, destination }, {})
  }

  app.post('/setup', async (c) => {
    const params = parseSyncParams(c.req.header('X-Sync-Params'))
    if (params instanceof Response) return params
    const engine = await resolveEngine(params)
    await engine.setup()
    return c.body(null, 204)
  })

  app.post('/teardown', async (c) => {
    const params = parseSyncParams(c.req.header('X-Sync-Params'))
    if (params instanceof Response) return params
    const engine = await resolveEngine(params)
    await engine.teardown()
    return c.body(null, 204)
  })

  app.get('/check', async (c) => {
    const params = parseSyncParams(c.req.header('X-Sync-Params'))
    if (params instanceof Response) return params
    const engine = await resolveEngine(params)
    const result = await engine.check()
    return c.json(result)
  })

  app.post('/read', async (c) => {
    const params = parseSyncParams(c.req.header('X-Sync-Params'))
    if (params instanceof Response) return params
    const engine = await resolveEngine(params)

    const text = await c.req.text()
    const input = text ? parseNdjson(text) : undefined
    return sseResponse(engine.read(input))
  })

  app.post('/write', async (c) => {
    const params = parseSyncParams(c.req.header('X-Sync-Params'))
    if (params instanceof Response) return params
    const engine = await resolveEngine(params)

    const text = await c.req.text()
    if (!text) {
      return c.json({ error: 'Request body required for /write' }, 400)
    }
    const messages = parseNdjson<Message>(text)
    return sseResponse(engine.write(messages))
  })

  app.post('/run', async (c) => {
    const params = parseSyncParams(c.req.header('X-Sync-Params'))
    if (params instanceof Response) return params
    const engine = await resolveEngine(params)

    const text = await c.req.text()
    const input = text ? parseNdjson(text) : undefined
    return sseResponse(engine.run(input))
  })

  return app
}
