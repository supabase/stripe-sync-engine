import { Hono } from 'hono'
import type {
  Message,
  ConnectorResolver,
  SyncParams as SyncParamsType,
} from '@stripe/stateless-sync'
import { createEngineFromParams, parseNdjson, SyncParams } from '@stripe/stateless-sync'
import { sseResponse } from './stream'

// Re-export core protocol types for consumers (e.g. stateful-api)
export type {
  Source,
  Destination,
  Stream,
  ConfiguredStream,
  ConfiguredCatalog,
  ConnectorSpecification,
  CheckResult,
  RecordMessage,
  StateMessage,
  CatalogMessage,
  LogMessage,
  ErrorMessage,
  StreamStatusMessage,
  DestinationInput,
  DestinationOutput,
  Message,
  SyncEngineParams,
  SyncParams,
  ConnectorResolver,
  ConnectorResolverOptions,
} from '@stripe/stateless-sync'

export {
  createEngine,
  createEngineFromParams,
  createConnectorResolver,
  resolveSpecifier,
  loadConnector,
} from '@stripe/stateless-sync'

export function createApp(resolver: ConnectorResolver) {
  const app = new Hono()

  /** Parse X-Sync-Params header or return a 400 Response. */
  function parseSyncParams(header: string | undefined): SyncParamsType | Response {
    if (!header) {
      return new Response(JSON.stringify({ error: 'Missing X-Sync-Params header' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    try {
      return SyncParams.parse(JSON.parse(header))
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON in X-Sync-Params header' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  app.post('/setup', async (c) => {
    const params = parseSyncParams(c.req.header('X-Sync-Params'))
    if (params instanceof Response) return params
    const engine = await createEngineFromParams(params, resolver, {})
    await engine.setup()
    return c.body(null, 204)
  })

  app.post('/teardown', async (c) => {
    const params = parseSyncParams(c.req.header('X-Sync-Params'))
    if (params instanceof Response) return params
    const engine = await createEngineFromParams(params, resolver, {})
    await engine.teardown()
    return c.body(null, 204)
  })

  app.get('/check', async (c) => {
    const params = parseSyncParams(c.req.header('X-Sync-Params'))
    if (params instanceof Response) return params
    const engine = await createEngineFromParams(params, resolver, {})
    const result = await engine.check()
    return c.json(result)
  })

  app.post('/read', async (c) => {
    const params = parseSyncParams(c.req.header('X-Sync-Params'))
    if (params instanceof Response) return params
    const engine = await createEngineFromParams(params, resolver, {})

    const text = await c.req.text()
    const input = text ? parseNdjson(text) : undefined
    return sseResponse(engine.read(input))
  })

  app.post('/write', async (c) => {
    const params = parseSyncParams(c.req.header('X-Sync-Params'))
    if (params instanceof Response) return params
    const engine = await createEngineFromParams(params, resolver, {})

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
    const engine = await createEngineFromParams(params, resolver, {})

    const text = await c.req.text()
    const input = text ? parseNdjson(text) : undefined
    return sseResponse(engine.run(input))
  })

  return app
}
