import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import { streamSSE } from 'hono/streaming'
import type { ConnectorResolver } from '@stripe/sync-engine-stateless-api'
import { createConnectorResolver } from '@stripe/sync-engine-stateless-api'
import {
  SyncService,
  fileCredentialStore,
  fileConfigStore,
  fileStateStore,
  fileLogSink,
} from '@stripe/sync-service'
import {
  CredentialConfigSchema,
  CredentialSchema,
  CreateSyncSchema,
  DeleteResponseSchema,
  ErrorSchema,
  ListResponse,
  SyncSchema,
  UpdateCredentialSchema,
  UpdateSyncSchema,
} from './schemas'
import {
  genId,
  credentialToStore,
  credentialToApi,
  syncToStoreConfig,
  storeConfigToSync,
} from './adapters'

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

  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues }, 400)
      }
    },
  })

  // ── Path param schemas ──────────────────────────────────────────

  const CredIdParam = z.object({
    id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'cred_abc123' }),
  })

  const SyncIdParam = z.object({
    id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'sync_abc123' }),
  })

  // MARK: - Credentials

  // List credentials
  app.openapi(
    createRoute({
      method: 'get',
      path: '/credentials',
      tags: ['Credentials'],
      summary: 'List credentials',
      responses: {
        200: {
          content: { 'application/json': { schema: ListResponse(CredentialSchema) } },
          description: 'List of credentials',
        },
      },
    }),
    async (c) => {
      const list = await credentials.list()
      return c.json({ data: list.map(credentialToApi), has_more: false } as any, 200)
    }
  )

  // Create credential
  app.openapi(
    createRoute({
      method: 'post',
      path: '/credentials',
      tags: ['Credentials'],
      summary: 'Create credential',
      request: {
        body: { content: { 'application/json': { schema: CredentialConfigSchema } } },
      },
      responses: {
        201: {
          content: { 'application/json': { schema: CredentialSchema } },
          description: 'Created credential',
        },
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Invalid input',
        },
      },
    }),
    async (c) => {
      const body = c.req.valid('json')
      const id = genId('cred')
      const stored = credentialToStore(id, body as Record<string, unknown>)
      await credentials.set(id, stored)
      return c.json(credentialToApi(stored) as any, 201)
    }
  )

  // Get credential
  app.openapi(
    createRoute({
      method: 'get',
      path: '/credentials/{id}',
      tags: ['Credentials'],
      summary: 'Retrieve credential',
      request: { params: CredIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: CredentialSchema } },
          description: 'Retrieved credential',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      try {
        const cred = await credentials.get(id)
        return c.json(credentialToApi(cred) as any, 200)
      } catch {
        return c.json({ error: `Credential ${id} not found` }, 404)
      }
    }
  )

  // Update credential
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/credentials/{id}',
      tags: ['Credentials'],
      summary: 'Update credential',
      request: {
        params: CredIdParam,
        body: { content: { 'application/json': { schema: UpdateCredentialSchema } } },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: CredentialSchema } },
          description: 'Updated credential',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const patch = c.req.valid('json')
      try {
        const existing = await credentials.get(id)
        const currentApi = credentialToApi(existing) as Record<string, unknown>
        const merged = { ...currentApi, ...patch }
        // Strip id and account_id — not stored in fields
        const { id: _id, account_id: _acct, ...credFields } = merged as any
        const updated = credentialToStore(id, credFields)
        updated.created_at = existing.created_at
        await credentials.set(id, updated)
        return c.json(credentialToApi(updated) as any, 200)
      } catch {
        return c.json({ error: `Credential ${id} not found` }, 404)
      }
    }
  )

  // Delete credential
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/credentials/{id}',
      tags: ['Credentials'],
      summary: 'Delete credential',
      request: { params: CredIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: DeleteResponseSchema } },
          description: 'Deleted credential',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      try {
        await credentials.get(id) // throws if not found
        await credentials.delete(id)
        return c.json({ id, deleted: true as const }, 200)
      } catch {
        return c.json({ error: `Credential ${id} not found` }, 404)
      }
    }
  )

  // MARK: - Syncs

  // List syncs
  app.openapi(
    createRoute({
      method: 'get',
      path: '/syncs',
      tags: ['Syncs'],
      summary: 'List syncs',
      responses: {
        200: {
          content: { 'application/json': { schema: ListResponse(SyncSchema) } },
          description: 'List of syncs',
        },
      },
    }),
    async (c) => {
      const list = await configs.list()
      return c.json({ data: list.map(storeConfigToSync), has_more: false } as any, 200)
    }
  )

  // Create sync
  app.openapi(
    createRoute({
      method: 'post',
      path: '/syncs',
      tags: ['Syncs'],
      summary: 'Create sync',
      request: {
        body: { content: { 'application/json': { schema: CreateSyncSchema } } },
      },
      responses: {
        201: {
          content: { 'application/json': { schema: SyncSchema } },
          description: 'Created sync',
        },
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Invalid input',
        },
      },
    }),
    async (c) => {
      const body = c.req.valid('json')
      const id = genId('sync')
      const stored = syncToStoreConfig(id, body as Record<string, unknown>)
      await configs.set(id, stored)
      return c.json(storeConfigToSync(stored) as any, 201)
    }
  )

  // Get sync
  app.openapi(
    createRoute({
      method: 'get',
      path: '/syncs/{id}',
      tags: ['Syncs'],
      summary: 'Retrieve sync',
      request: { params: SyncIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: SyncSchema } },
          description: 'Retrieved sync',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      try {
        const config = await configs.get(id)
        return c.json(storeConfigToSync(config) as any, 200)
      } catch {
        return c.json({ error: `Sync ${id} not found` }, 404)
      }
    }
  )

  // Update sync
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/syncs/{id}',
      tags: ['Syncs'],
      summary: 'Update sync',
      request: {
        params: SyncIdParam,
        body: { content: { 'application/json': { schema: UpdateSyncSchema } } },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: SyncSchema } },
          description: 'Updated sync',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const patch = c.req.valid('json')
      try {
        const existing = await configs.get(id)
        const currentApi = storeConfigToSync(existing)
        const merged = { ...currentApi, ...patch }
        const updatedConfig = syncToStoreConfig(id, merged)
        await configs.set(id, updatedConfig)
        return c.json(storeConfigToSync(updatedConfig) as any, 200)
      } catch {
        return c.json({ error: `Sync ${id} not found` }, 404)
      }
    }
  )

  // Delete sync
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/syncs/{id}',
      tags: ['Syncs'],
      summary: 'Delete sync',
      request: { params: SyncIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: DeleteResponseSchema } },
          description: 'Deleted sync',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      try {
        await configs.get(id) // throws if not found
        await configs.delete(id)
        return c.json({ id, deleted: true as const }, 200)
      } catch {
        return c.json({ error: `Sync ${id} not found` }, 404)
      }
    }
  )

  // MARK: - Run sync (SSE) — plain Hono route, SSE doesn't fit OpenAPI

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

  // MARK: - OpenAPI spec + Swagger UI

  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'Sync Service API',
      version: '1.0.0',
      description: 'Stripe Sync Service — manage credentials and syncs',
    },
  })

  app.get('/docs', swaggerUI({ url: '/openapi.json' }))

  return app
}
