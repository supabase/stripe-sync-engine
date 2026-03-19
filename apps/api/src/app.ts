import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
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
import { credentials, syncs } from './store'

export const app = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ error: result.error.issues }, 400)
    }
  },
})

// ── Path param schemas ──────────────────────────────────────────

const CredIdParam = z.object({
  id: z.string().openapi({
    param: { name: 'id', in: 'path' },
    example: 'cred_abc123',
  }),
})

const SyncIdParam = z.object({
  id: z.string().openapi({
    param: { name: 'id', in: 'path' },
    example: 'sync_abc123',
  }),
})

// ── Credentials ─────────────────────────────────────────────────

// List credentials
app.openapi(
  createRoute({
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
  (c) => c.json(credentials.list() as any, 200),
)

// Create credential
app.openapi(
  createRoute({
    method: 'post',
    path: '/credentials',
    tags: ['Credentials'],
    summary: 'Create credential',
    request: {
      body: {
        content: { 'application/json': { schema: CredentialConfigSchema } },
      },
    },
    responses: {
      200: {
        content: { 'application/json': { schema: CredentialSchema } },
        description: 'Created credential',
      },
    },
  }),
  (c) => {
    const body = c.req.valid('json')
    return c.json(credentials.create(body) as any, 200)
  },
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
  (c) => {
    const { id } = c.req.valid('param')
    const cred = credentials.get(id)
    if (!cred) return c.json({ error: `Credential ${id} not found` }, 404)
    return c.json(cred as any, 200)
  },
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
  (c) => {
    const { id } = c.req.valid('param')
    const body = c.req.valid('json')
    const cred = credentials.update(id, body)
    if (!cred) return c.json({ error: `Credential ${id} not found` }, 404)
    return c.json(cred as any, 200)
  },
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
  (c) => {
    const { id } = c.req.valid('param')
    const result = credentials.delete(id)
    if (!result) return c.json({ error: `Credential ${id} not found` }, 404)
    return c.json(result as any, 200)
  },
)

// ── Syncs ───────────────────────────────────────────────────────

// List syncs
app.openapi(
  createRoute({
    method: 'get',
    path: '/syncs',
    tags: ['Syncs'],
    summary: 'List syncs',
    responses: {
      200: {
        content: {
          'application/json': { schema: ListResponse(SyncSchema) },
        },
        description: 'List of syncs',
      },
    },
  }),
  (c) => c.json(syncs.list() as any, 200),
)

// Create sync
app.openapi(
  createRoute({
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
      200: {
        content: { 'application/json': { schema: SyncSchema } },
        description: 'Created sync',
      },
    },
  }),
  (c) => {
    const body = c.req.valid('json')
    return c.json(syncs.create(body) as any, 200)
  },
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
  (c) => {
    const { id } = c.req.valid('param')
    const sync = syncs.get(id)
    if (!sync) return c.json({ error: `Sync ${id} not found` }, 404)
    return c.json(sync as any, 200)
  },
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
      body: {
        content: { 'application/json': { schema: UpdateSyncSchema } },
      },
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
  (c) => {
    const { id } = c.req.valid('param')
    const body = c.req.valid('json')
    const sync = syncs.update(id, body)
    if (!sync) return c.json({ error: `Sync ${id} not found` }, 404)
    return c.json(sync as any, 200)
  },
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
  (c) => {
    const { id } = c.req.valid('param')
    const result = syncs.delete(id)
    if (!result) return c.json({ error: `Sync ${id} not found` }, 404)
    return c.json(result as any, 200)
  },
)

// ── OpenAPI spec + Swagger UI ───────────────────────────────────

app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'Sync Service API',
    version: '1.0.0',
    description: 'Stripe Sync Service — manage credentials and syncs',
  },
})

app.get('/docs', swaggerUI({ url: '/openapi.json' }))
