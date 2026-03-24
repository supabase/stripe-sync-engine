import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type {
  Message,
  ConnectorResolver,
  SyncParams as SyncParamsType,
} from '@stripe/stateless-sync'
import { createEngineFromParams, parseNdjsonStream, SyncParams } from '@stripe/stateless-sync'
import { ndjsonResponse } from '../stream'

export function createApp(resolver: ConnectorResolver) {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status as any)
    }
    console.error(err)
    return c.json({ error: 'Internal server error' }, 500)
  })

  /** Node.js 24 sets c.req.raw.body to a non-null empty ReadableStream even for bodyless POSTs. */
  function hasBody(c: { req: { header: (name: string) => string | undefined } }): boolean {
    const cl = c.req.header('Content-Length')
    if (cl && Number(cl) > 0) return true
    if (c.req.header('Transfer-Encoding')) return true
    return false
  }

  app.get('/health', (c) => c.json({ ok: true }))

  /** Parse and validate X-Sync-Params header, or throw 400. */
  function requireSyncParams(header: string | undefined): SyncParamsType {
    if (!header) {
      throw new HTTPException(400, { message: 'Missing X-Sync-Params header' })
    }
    try {
      return SyncParams.parse(JSON.parse(header))
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON in X-Sync-Params header' })
    }
  }

  app.post('/setup', async (c) => {
    const params = requireSyncParams(c.req.header('X-Sync-Params'))
    const engine = await createEngineFromParams(params, resolver, {})
    await engine.setup()
    return c.body(null, 204)
  })

  app.post('/teardown', async (c) => {
    const params = requireSyncParams(c.req.header('X-Sync-Params'))
    const engine = await createEngineFromParams(params, resolver, {})
    await engine.teardown()
    return c.body(null, 204)
  })

  app.get('/check', async (c) => {
    const params = requireSyncParams(c.req.header('X-Sync-Params'))
    const engine = await createEngineFromParams(params, resolver, {})
    const result = await engine.check()
    return c.json(result)
  })

  app.post('/read', async (c) => {
    const params = requireSyncParams(c.req.header('X-Sync-Params'))
    const engine = await createEngineFromParams(params, resolver, {})

    const input = hasBody(c) ? parseNdjsonStream(c.req.raw.body!) : undefined
    return ndjsonResponse(engine.read(input))
  })

  app.post('/write', async (c) => {
    const params = requireSyncParams(c.req.header('X-Sync-Params'))
    const engine = await createEngineFromParams(params, resolver, {})

    if (!hasBody(c)) {
      return c.json({ error: 'Request body required for /write' }, 400)
    }
    const messages = parseNdjsonStream<Message>(c.req.raw.body!)
    return ndjsonResponse(engine.write(messages))
  })

  app.post('/run', async (c) => {
    const params = requireSyncParams(c.req.header('X-Sync-Params'))
    const engine = await createEngineFromParams(params, resolver, {})

    const input = hasBody(c) ? parseNdjsonStream(c.req.raw.body!) : undefined
    return ndjsonResponse(engine.run(input))
  })

  return app
}
