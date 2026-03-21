import { homedir } from 'node:os'
import { join } from 'node:path'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import type { ConnectorResolver, Message } from '@stripe/sync-engine-stateless'
import {
  createConnectorResolver,
  ndjsonResponse,
  parseNdjsonStream,
} from '@stripe/sync-engine-stateless'
import {
  StatefulSync,
  fileCredentialStore,
  fileConfigStore,
  fileStateStore,
  fileLogSink,
} from '@stripe/stateful-sync'
import type { Credential, SyncConfig } from '@stripe/stateful-sync'
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

let _idCounter = Date.now()
function genId(prefix: string): string {
  return `${prefix}_${(_idCounter++).toString(36)}`
}

export function createApp(options?: { dataDir?: string; connectors?: ConnectorResolver }) {
  const dataDir = options?.dataDir || process.env.DATA_DIR || join(homedir(), '.stripe-sync')

  const credentials = fileCredentialStore(`${dataDir}/credentials.json`)
  const configs = fileConfigStore(`${dataDir}/syncs.json`)
  const states = fileStateStore(`${dataDir}/state.json`)
  const logs = fileLogSink(`${dataDir}/logs.ndjson`)

  const service = new StatefulSync({
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
      return c.json(
        {
          data: list.map((cred) => ({ ...cred, account_id: 'acct_default' })),
          has_more: false,
        } as any,
        200
      )
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
      const now = new Date().toISOString()
      const stored = {
        id,
        ...(body as Record<string, unknown>),
        created_at: now,
        updated_at: now,
      } as Credential
      await credentials.set(id, stored)
      return c.json({ ...stored, account_id: 'acct_default' } as any, 201)
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
        return c.json({ ...cred, account_id: 'acct_default' } as any, 200)
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
        // Strip id and account_id from patch — they're not writable fields
        const cleanPatch = Object.fromEntries(
          Object.entries(patch as Record<string, unknown>).filter(
            ([k]) => k !== 'id' && k !== 'account_id'
          )
        )
        const updated = {
          ...existing,
          ...cleanPatch,
          id,
          updated_at: new Date().toISOString(),
        } as Credential
        await credentials.set(id, updated)
        return c.json({ ...updated, account_id: 'acct_default' } as any, 200)
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
        409: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Credential is referenced by one or more syncs',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      try {
        await credentials.get(id) // throws if not found
      } catch {
        return c.json({ error: `Credential ${id} not found` }, 404)
      }

      // Check for syncs referencing this credential
      const allSyncs = await configs.list()
      const referencing = allSyncs.filter(
        (s) => s.source.credential_id === id || s.destination.credential_id === id
      )
      if (referencing.length > 0) {
        return c.json(
          {
            error: `Credential ${id} is referenced by sync(s): ${referencing.map((s) => s.id).join(', ')}`,
          },
          409
        )
      }

      await credentials.delete(id)
      return c.json({ id, deleted: true as const }, 200)
    }
  )

  // ── Referential integrity helpers ───────────────────────────────

  /** Collect all credential_id references from a sync body (source + destination). */
  function collectCredentialIds(body: Record<string, unknown>): string[] {
    const ids: string[] = []
    const src = body.source as Record<string, unknown> | undefined
    const dst = body.destination as Record<string, unknown> | undefined
    if (src?.credential_id && typeof src.credential_id === 'string') ids.push(src.credential_id)
    if (dst?.credential_id && typeof dst.credential_id === 'string') ids.push(dst.credential_id)
    return ids
  }

  /** Validate that all referenced credential_ids exist. Returns missing IDs or empty array. */
  async function validateCredentialRefs(credIds: string[]): Promise<string[]> {
    const missing: string[] = []
    for (const id of credIds) {
      try {
        await credentials.get(id)
      } catch {
        missing.push(id)
      }
    }
    return missing
  }

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
      return c.json({ data: list, has_more: false } as any, 200)
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

      // Validate referenced credentials exist
      const credIds = collectCredentialIds(body as Record<string, unknown>)
      const missing = await validateCredentialRefs(credIds)
      if (missing.length > 0) {
        return c.json({ error: `Credential(s) not found: ${missing.join(', ')}` }, 400)
      }

      const id = genId('sync')
      const stored = { id, ...(body as Record<string, unknown>) } as SyncConfig
      await configs.set(id, stored)
      return c.json(stored as any, 201)
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
        return c.json(config as any, 200)
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
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Invalid input',
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

        // Validate referenced credentials exist in the patch
        const credIds = collectCredentialIds(patch as Record<string, unknown>)
        const missing = await validateCredentialRefs(credIds)
        if (missing.length > 0) {
          return c.json({ error: `Credential(s) not found: ${missing.join(', ')}` }, 400)
        }

        const updated = { ...existing, ...(patch as Record<string, unknown>), id } as SyncConfig
        await configs.set(id, updated)
        return c.json(updated as any, 200)
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

  // MARK: - Sync engine operations — plain Hono routes (streaming, not OpenAPI)

  app.post('/syncs/:id/setup', async (c) => {
    const syncId = c.req.param('id')
    await service.setup(syncId)
    return c.body(null, 204)
  })

  app.post('/syncs/:id/teardown', async (c) => {
    const syncId = c.req.param('id')
    await service.teardown(syncId)
    return c.body(null, 204)
  })

  app.get('/syncs/:id/check', async (c) => {
    const syncId = c.req.param('id')
    const result = await service.check(syncId)
    return c.json(result)
  })

  app.post('/syncs/:id/read', async (c) => {
    const syncId = c.req.param('id')
    const body = c.req.raw.body
    const input = body ? parseNdjsonStream(body) : undefined
    return ndjsonResponse(service.read(syncId, input))
  })

  app.post('/syncs/:id/write', async (c) => {
    const syncId = c.req.param('id')
    const body = c.req.raw.body
    if (!body) {
      return c.json({ error: 'Request body required for /write' }, 400)
    }
    const messages = parseNdjsonStream<Message>(body)
    return ndjsonResponse(service.write(syncId, messages))
  })

  app.post('/syncs/:id/run', async (c) => {
    const syncId = c.req.param('id')
    const body = c.req.raw.body
    const input = body ? parseNdjsonStream(body) : undefined
    return ndjsonResponse(service.run(syncId, input))
  })

  // MARK: - Webhook ingress

  // Receive a webhook event from Stripe and fan it out to all running syncs
  // that share the given credential. Each sync verifies the signature itself.
  app.post('/webhooks/:credential_id', async (c) => {
    const credential_id = c.req.param('credential_id')
    const body = await c.req.text()
    const headers = Object.fromEntries(c.req.raw.headers.entries())
    service.push_event(credential_id, { body, headers })
    return c.text('ok', 200)
  })

  // MARK: - OpenAPI spec + Swagger UI

  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'Stripe Sync Stateful API',
      version: '1.0.0',
      description: 'Stripe Sync (stateful) — manage credentials and syncs',
    },
  })

  app.get('/docs', swaggerUI({ url: '/openapi.json' }))

  return app
}
