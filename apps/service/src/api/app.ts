import { homedir } from 'node:os'
import { join } from 'node:path'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import type { ConnectorResolver, Message } from '@stripe/sync-engine'
import { createConnectorResolver, parseNdjsonStream } from '@stripe/sync-engine'
import { ndjsonResponse } from '@stripe/sync-engine'
import {
  Credential as CredentialSchema,
  CreateCredential as CreateCredentialSchema,
  UpdateCredential as UpdateCredentialSchema,
  SyncConfig as SyncConfigSchema,
  CreateSync as CreateSyncSchema,
  UpdateSync as UpdateSyncSchema,
} from '../lib/schemas.js'
import type { Credential, SyncConfig } from '../lib/schemas.js'
import { SyncService } from '../lib/service.js'
import {
  fileCredentialStore,
  fileConfigStore,
  fileStateStore,
  fileLogSink,
} from '../lib/stores-fs.js'

// MARK: - Helpers

let _idCounter = Date.now()
function genId(prefix: string): string {
  return `${prefix}_${(_idCounter++).toString(36)}`
}

// MARK: - Response schemas

const ConnectorCheckSchema = z.object({
  status: z.enum(['succeeded', 'failed']),
  message: z.string().optional(),
})

const CheckResultSchema = z.object({
  source: ConnectorCheckSchema,
  destination: ConnectorCheckSchema,
})

const NdjsonSchema = z.string().openapi({
  description: 'Newline-delimited JSON sync messages, one per line',
  example: '{"type":"record","stream":"products","data":{"id":"prod_123","name":"Widget"}}\n',
})

const DeleteResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
})

const ErrorSchema = z.object({ error: z.unknown() })

function ListResponse<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    has_more: z.boolean(),
  })
}

// MARK: - App factory

export interface AppOptions {
  dataDir?: string
  /** Pre-built connector resolver (for tests with mocks). */
  connectors?: ConnectorResolver
}

export function createApp(options?: AppOptions) {
  const dataDir = options?.dataDir || process.env.DATA_DIR || join(homedir(), '.stripe-sync')
  const connectors = options?.connectors ?? createConnectorResolver({})

  const credentials = fileCredentialStore(`${dataDir}/credentials`)
  const configs = fileConfigStore(`${dataDir}/syncs`)
  const states = fileStateStore(`${dataDir}/state`)
  const logs = fileLogSink(`${dataDir}/logs.ndjson`)

  const service = new SyncService({
    credentials,
    configs,
    states,
    logs,
    connectors,
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

  const WebhookParam = z.object({
    credential_id: z.string().openapi({
      param: { name: 'credential_id', in: 'path' },
      example: 'cred_abc123',
    }),
  })

  // ── Health ──────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      operationId: 'health',
      method: 'get',
      path: '/health',
      tags: ['Status'],
      summary: 'Health check',
      responses: {
        200: {
          content: {
            'application/json': { schema: z.object({ ok: z.literal(true) }) },
          },
          description: 'Server is healthy',
        },
      },
    }),
    (c) => c.json({ ok: true as const }, 200)
  )

  // MARK: - Credentials

  app.openapi(
    createRoute({
      operationId: 'listCredentials',
      method: 'get',
      path: '/credentials',
      tags: ['Credentials'],
      summary: 'List credentials',
      responses: {
        200: {
          content: {
            'application/json': { schema: ListResponse(CredentialSchema) },
          },
          description: 'List of credentials',
        },
      },
    }),
    async (c) => {
      const list = await credentials.list()
      return c.json({ data: list, has_more: false } as any, 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'createCredential',
      method: 'post',
      path: '/credentials',
      tags: ['Credentials'],
      summary: 'Create credential',
      request: {
        body: {
          content: { 'application/json': { schema: CreateCredentialSchema } },
        },
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
      return c.json(stored as any, 201)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'getCredential',
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
        return c.json(cred as any, 200)
      } catch {
        return c.json({ error: `Credential ${id} not found` }, 404)
      }
    }
  )

  app.openapi(
    createRoute({
      operationId: 'updateCredential',
      method: 'patch',
      path: '/credentials/{id}',
      tags: ['Credentials'],
      summary: 'Update credential',
      request: {
        params: CredIdParam,
        body: {
          content: { 'application/json': { schema: UpdateCredentialSchema } },
        },
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
        const cleanPatch = Object.fromEntries(
          Object.entries(patch as Record<string, unknown>).filter(([k]) => k !== 'id')
        )
        const updated = {
          ...existing,
          ...cleanPatch,
          id,
          updated_at: new Date().toISOString(),
        } as Credential
        await credentials.set(id, updated)
        return c.json(updated as any, 200)
      } catch {
        return c.json({ error: `Credential ${id} not found` }, 404)
      }
    }
  )

  app.openapi(
    createRoute({
      operationId: 'deleteCredential',
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
        await credentials.get(id)
      } catch {
        return c.json({ error: `Credential ${id} not found` }, 404)
      }

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

  function collectCredentialIds(body: Record<string, unknown>): string[] {
    const ids: string[] = []
    const src = body.source as Record<string, unknown> | undefined
    const dst = body.destination as Record<string, unknown> | undefined
    if (src?.credential_id && typeof src.credential_id === 'string') ids.push(src.credential_id)
    if (dst?.credential_id && typeof dst.credential_id === 'string') ids.push(dst.credential_id)
    return ids
  }

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

  app.openapi(
    createRoute({
      operationId: 'listSyncs',
      method: 'get',
      path: '/syncs',
      tags: ['Syncs'],
      summary: 'List syncs',
      responses: {
        200: {
          content: {
            'application/json': { schema: ListResponse(SyncConfigSchema) },
          },
          description: 'List of syncs',
        },
      },
    }),
    async (c) => {
      const list = await configs.list()
      return c.json({ data: list, has_more: false } as any, 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'createSync',
      method: 'post',
      path: '/syncs',
      tags: ['Syncs'],
      summary: 'Create sync',
      request: {
        body: {
          content: { 'application/json': { schema: CreateSyncSchema } },
        },
      },
      responses: {
        201: {
          content: { 'application/json': { schema: SyncConfigSchema } },
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

  app.openapi(
    createRoute({
      operationId: 'getSync',
      method: 'get',
      path: '/syncs/{id}',
      tags: ['Syncs'],
      summary: 'Retrieve sync',
      request: { params: SyncIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: SyncConfigSchema } },
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

  app.openapi(
    createRoute({
      operationId: 'updateSync',
      method: 'patch',
      path: '/syncs/{id}',
      tags: ['Syncs'],
      summary: 'Update sync',
      request: {
        params: SyncIdParam,
        body: {
          content: { 'application/json': { schema: UpdateSyncSchema } },
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: SyncConfigSchema } },
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

        const credIds = collectCredentialIds(patch as Record<string, unknown>)
        const missing = await validateCredentialRefs(credIds)
        if (missing.length > 0) {
          return c.json({ error: `Credential(s) not found: ${missing.join(', ')}` }, 400)
        }

        const updated = {
          ...existing,
          ...(patch as Record<string, unknown>),
          id,
        } as SyncConfig
        await configs.set(id, updated)
        return c.json(updated as any, 200)
      } catch {
        return c.json({ error: `Sync ${id} not found` }, 404)
      }
    }
  )

  app.openapi(
    createRoute({
      operationId: 'deleteSync',
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
        await configs.get(id)
        await configs.delete(id)
        await states.clear(id)
        return c.json({ id, deleted: true as const }, 200)
      } catch {
        return c.json({ error: `Sync ${id} not found` }, 404)
      }
    }
  )

  // MARK: - Sync engine operations

  app.openapi(
    createRoute({
      operationId: 'setupSync',
      method: 'post',
      path: '/syncs/{id}/setup',
      tags: ['Sync Operations'],
      summary: 'Set up destination schema for a sync',
      description:
        'Creates destination tables and applies migrations. Safe to call multiple times.',
      request: { params: SyncIdParam },
      responses: {
        204: { description: 'Setup complete' },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Sync not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      await service.setup(id)
      return c.body(null, 204) as any
    }
  )

  app.openapi(
    createRoute({
      operationId: 'teardownSync',
      method: 'post',
      path: '/syncs/{id}/teardown',
      tags: ['Sync Operations'],
      summary: 'Tear down destination schema for a sync',
      description: 'Drops destination tables. Irreversible.',
      request: { params: SyncIdParam },
      responses: {
        204: { description: 'Teardown complete' },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Sync not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      await service.teardown(id)
      return c.body(null, 204) as any
    }
  )

  app.openapi(
    createRoute({
      operationId: 'checkSync',
      method: 'get',
      path: '/syncs/{id}/check',
      tags: ['Sync Operations'],
      summary: 'Check connector connection for a sync',
      description: 'Validates the source/destination config and tests connectivity.',
      request: { params: SyncIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: CheckResultSchema } },
          description: 'Connection check result',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Sync not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const result = await service.check(id)
      return c.json(result, 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'readSync',
      method: 'post',
      path: '/syncs/{id}/read',
      tags: ['Sync Operations'],
      summary: 'Read records from the sync source',
      description:
        'Streams NDJSON messages (records, state, catalog). Optional NDJSON body provides input.',
      request: { params: SyncIdParam },
      responses: {
        200: {
          content: { 'application/x-ndjson': { schema: NdjsonSchema } },
          description: 'NDJSON stream of sync messages',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Sync not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.raw.body
      const input = body ? parseNdjsonStream(body) : undefined
      return ndjsonResponse(service.read(id, input)) as any
    }
  )

  app.openapi(
    createRoute({
      operationId: 'writeSync',
      method: 'post',
      path: '/syncs/{id}/write',
      tags: ['Sync Operations'],
      summary: 'Write records to the sync destination',
      description:
        'Reads NDJSON messages from the request body and writes them to the destination.',
      request: {
        params: SyncIdParam,
        body: {
          required: true,
          content: { 'application/x-ndjson': { schema: NdjsonSchema } },
        },
      },
      responses: {
        200: {
          content: { 'application/x-ndjson': { schema: NdjsonSchema } },
          description: 'NDJSON stream of write result messages',
        },
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Missing request body',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Sync not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.raw.body
      if (!body) {
        return c.json({ error: 'Request body required for /write' }, 400)
      }
      const messages = parseNdjsonStream<Message>(body)
      return ndjsonResponse(service.write(id, messages)) as any
    }
  )

  app.openapi(
    createRoute({
      operationId: 'runSync',
      method: 'post',
      path: '/syncs/{id}/run',
      tags: ['Sync Operations'],
      summary: 'Run full sync (read → write pipeline)',
      description: 'Executes a complete source→destination sync. Streams NDJSON messages.',
      request: { params: SyncIdParam },
      responses: {
        200: {
          content: { 'application/x-ndjson': { schema: NdjsonSchema } },
          description: 'NDJSON stream of sync messages',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Sync not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.raw.body
      const input = body && c.req.header('content-type') ? parseNdjsonStream(body) : undefined
      return ndjsonResponse(service.run(id, input)) as any
    }
  )

  // MARK: - Webhook ingress

  app.openapi(
    createRoute({
      operationId: 'pushWebhook',
      method: 'post',
      path: '/webhooks/{credential_id}',
      tags: ['Webhooks'],
      summary: 'Ingest a Stripe webhook event',
      description:
        'Receives a raw Stripe webhook and fans it out to all active syncs sharing the credential.',
      request: { params: WebhookParam },
      responses: {
        200: {
          content: { 'text/plain': { schema: z.literal('ok') } },
          description: 'Event accepted',
        },
      },
    }),
    async (c) => {
      const { credential_id } = c.req.valid('param')
      const body = await c.req.text()
      const headers = Object.fromEntries(c.req.raw.headers.entries())
      service.push_event(credential_id, { body, headers })
      return c.text('ok', 200)
    }
  )

  // MARK: - OpenAPI spec + Swagger UI

  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'Stripe Sync Service API',
      version: '1.0.0',
      description: 'Stripe Sync Service — manage credentials, syncs, and webhook ingress',
    },
  })

  app.get('/docs', swaggerUI({ url: '/openapi.json' }))

  return app
}
