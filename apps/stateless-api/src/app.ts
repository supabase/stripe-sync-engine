import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
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

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status as any)
    }
    return c.json({ error: 'Internal server error' }, 500)
  })

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

    const text = await c.req.text()
    const input = text ? parseNdjson(text) : undefined
    return sseResponse(engine.read(input))
  })

  app.post('/write', async (c) => {
    const params = requireSyncParams(c.req.header('X-Sync-Params'))
    const engine = await createEngineFromParams(params, resolver, {})

    const text = await c.req.text()
    if (!text) {
      return c.json({ error: 'Request body required for /write' }, 400)
    }
    const messages = parseNdjson<Message>(text)
    return sseResponse(engine.write(messages))
  })

  app.post('/run', async (c) => {
    const params = requireSyncParams(c.req.header('X-Sync-Params'))
    const engine = await createEngineFromParams(params, resolver, {})

    const text = await c.req.text()
    const input = text ? parseNdjson(text) : undefined
    return sseResponse(engine.run(input))
  })

  return app
}
