/**
 * HTTP wiring example: file-backed stores → Hono app → SSE streaming.
 *
 * Routes:
 *   GET    /credentials        — list credentials
 *   POST   /credentials        — create credential
 *   GET    /credentials/:id    — get credential
 *   DELETE /credentials/:id    — delete credential
 *
 *   GET    /syncs              — list sync configs
 *   POST   /syncs              — create sync config
 *   GET    /syncs/:id          — get sync config
 *   DELETE /syncs/:id          — delete sync config
 *   POST   /syncs/:id/run      — run sync, SSE stream of state messages
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createConnectorResolver } from '@stripe/sync-protocol'
import { SyncService } from '../service'
import { fileCredentialStore, fileConfigStore, fileStateStore, fileLogSink } from '../stores/file'
import type { Credential, SyncConfig } from '../stores'

const DATA_DIR = process.env.DATA_DIR || '.sync-service'

const credentials = fileCredentialStore(`${DATA_DIR}/credentials.json`)
const configs = fileConfigStore(`${DATA_DIR}/syncs.json`)
const states = fileStateStore(`${DATA_DIR}/state.json`)
const logs = fileLogSink(`${DATA_DIR}/logs.ndjson`)

const service = new SyncService({
  credentials,
  configs,
  states,
  logs,
  connectors: createConnectorResolver({}),
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

export default app
