import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ConnectorResolver } from '@stripe/sync-protocol'
import { createConnectorResolver } from '@stripe/sync-protocol'
import {
  SyncService,
  fileCredentialStore,
  fileConfigStore,
  fileStateStore,
  fileLogSink,
} from '@stripe/sync-service'
import type { Credential, SyncConfig } from '@stripe/sync-service'

export function createApp(options?: { dataDir?: string; connectors?: ConnectorResolver }) {
  const dataDir = options?.dataDir || process.env.DATA_DIR || '.sync-service'

  const credentials = fileCredentialStore(`${dataDir}/credentials.json`)
  const configs = fileConfigStore(`${dataDir}/syncs.json`)
  const states = fileStateStore(`${dataDir}/state.json`)
  const logs = fileLogSink(`${dataDir}/logs.ndjson`)

  const service = new SyncService({
    credentials,
    configs,
    states,
    logs,
    connectors: options?.connectors ?? createConnectorResolver({}),
  })

  const app = new Hono()

  // MARK: - Credentials CRUD

  app.get('/credentials', async (c) => {
    const list = await credentials.list()
    return c.json({ data: list })
  })

  app.post('/credentials', async (c) => {
    const body = (await c.req.json()) as Credential
    if (!body.id) return c.json({ error: 'id is required' }, 400)
    await credentials.set(body.id, body)
    return c.json(body, 201)
  })

  app.get('/credentials/:id', async (c) => {
    try {
      const cred = await credentials.get(c.req.param('id'))
      return c.json(cred)
    } catch {
      return c.json({ error: 'not found' }, 404)
    }
  })

  app.delete('/credentials/:id', async (c) => {
    await credentials.delete(c.req.param('id'))
    return c.json({ deleted: true })
  })

  // MARK: - Syncs CRUD

  app.get('/syncs', async (c) => {
    const list = await configs.list()
    return c.json({ data: list })
  })

  app.post('/syncs', async (c) => {
    const body = (await c.req.json()) as SyncConfig
    if (!body.id) return c.json({ error: 'id is required' }, 400)
    await configs.set(body.id, body)
    return c.json(body, 201)
  })

  app.get('/syncs/:id', async (c) => {
    try {
      const config = await configs.get(c.req.param('id'))
      return c.json(config)
    } catch {
      return c.json({ error: 'not found' }, 404)
    }
  })

  app.delete('/syncs/:id', async (c) => {
    await configs.delete(c.req.param('id'))
    return c.json({ deleted: true })
  })

  // MARK: - Run sync (SSE)

  app.post('/syncs/:id/run', async (c) => {
    const syncId = c.req.param('id')
    return streamSSE(c, async (stream) => {
      try {
        let eventId = 0
        for await (const msg of service.run(syncId)) {
          await stream.writeSSE({
            id: String(eventId++),
            event: 'state',
            data: JSON.stringify(msg),
          })
        }
        await stream.writeSSE({
          id: String(eventId++),
          event: 'done',
          data: JSON.stringify({ status: 'completed' }),
        })
      } catch (err) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        })
      }
    })
  })

  return app
}
