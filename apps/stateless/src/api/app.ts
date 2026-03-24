import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import { HTTPException } from 'hono/http-exception'
import type {
  Message,
  ConnectorResolver,
  SyncParams as SyncParamsType,
} from '@stripe/stateless-sync'
import { createEngineFromParams, parseNdjsonStream, SyncParams } from '@stripe/stateless-sync'
import { ndjsonResponse } from '../stream'

// ── Shared schemas ──────────────────────────────────────────────

const XSyncParamsHeader = z.object({
  'x-sync-params': z
    .string()
    .optional()
    .openapi({
      description:
        'JSON-encoded SyncParams: { source_name, source_config, destination_name, destination_config, streams }',
      example: JSON.stringify({
        source_name: 'stripe',
        source_config: { api_key: 'sk_test_...' },
        destination_name: 'postgres',
        destination_config: { connection_string: 'postgres://localhost/db' },
        streams: [{ name: 'products' }],
      }),
    }),
})

const ConnectorCheckSchema = z.object({
  status: z.enum(['succeeded', 'failed']),
  message: z.string().optional(),
})

const CheckResultSchema = z.object({
  source: ConnectorCheckSchema,
  destination: ConnectorCheckSchema,
})

const ErrorSchema = z.object({ error: z.unknown() })

const NdjsonSchema = z.string().openapi({
  description: 'Newline-delimited JSON sync messages, one per line',
  example: '{"type":"record","stream":"products","data":{"id":"prod_123","name":"Widget"}}\n',
})

// ── App factory ────────────────────────────────────────────────

export function createApp(resolver: ConnectorResolver) {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues }, 400)
      }
    },
  })

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status as any)
    }
    console.error(err)
    return c.json({ error: 'Internal server error' }, 500)
  })

  /** Node.js 24 sets c.req.raw.body to a non-null empty ReadableStream even for bodyless POSTs. */
  function hasBody(c: {
    req: { header: (name: string) => string | undefined; raw: { body: ReadableStream | null } }
  }): boolean {
    const cl = c.req.header('Content-Length')
    if (cl !== undefined) return Number(cl) > 0
    if (c.req.header('Transfer-Encoding')) return true
    // In tests (app.request()), body is null for bodyless requests.
    // In Node.js 24 HTTP server, bodyless POSTs always arrive with Content-Length: 0,
    // so we never reach this line for real bodyless requests.
    return c.req.raw.body !== null
  }

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

  // ── Routes ─────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: 'get',
      path: '/health',
      tags: ['Status'],
      summary: 'Health check',
      responses: {
        200: {
          content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
          description: 'Server is healthy',
        },
      },
    }),
    (c) => c.json({ ok: true as const }, 200)
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/setup',
      tags: ['Sync'],
      summary: 'Set up destination schema',
      description:
        'Creates destination tables and applies migrations. Safe to call multiple times.',
      request: { headers: XSyncParamsHeader },
      responses: {
        204: { description: 'Setup complete' },
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Invalid params',
        },
      },
    }),
    async (c) => {
      const params = requireSyncParams(c.req.header('X-Sync-Params'))
      const engine = await createEngineFromParams(params, resolver, {})
      await engine.setup()
      return c.body(null, 204) as any
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/teardown',
      tags: ['Sync'],
      summary: 'Tear down destination schema',
      description: 'Drops destination tables. Irreversible.',
      request: { headers: XSyncParamsHeader },
      responses: {
        204: { description: 'Teardown complete' },
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Invalid params',
        },
      },
    }),
    async (c) => {
      const params = requireSyncParams(c.req.header('X-Sync-Params'))
      const engine = await createEngineFromParams(params, resolver, {})
      await engine.teardown()
      return c.body(null, 204) as any
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/check',
      tags: ['Sync'],
      summary: 'Check connector connection',
      description: 'Validates the source/destination config and tests connectivity.',
      request: { headers: XSyncParamsHeader },
      responses: {
        200: {
          content: { 'application/json': { schema: CheckResultSchema } },
          description: 'Connection check result',
        },
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Invalid params',
        },
      },
    }),
    async (c) => {
      const params = requireSyncParams(c.req.header('X-Sync-Params'))
      const engine = await createEngineFromParams(params, resolver, {})
      const result = await engine.check()
      return c.json(result, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/read',
      tags: ['Sync'],
      summary: 'Read records from source',
      description:
        'Streams NDJSON messages (records, state, catalog). Optional NDJSON body provides catalog/state as input.',
      request: { headers: XSyncParamsHeader },
      responses: {
        200: {
          content: { 'application/x-ndjson': { schema: NdjsonSchema } },
          description: 'NDJSON stream of sync messages',
        },
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Invalid params',
        },
      },
    }),
    async (c) => {
      const params = requireSyncParams(c.req.header('X-Sync-Params'))
      const engine = await createEngineFromParams(params, resolver, {})
      const input = hasBody(c) ? parseNdjsonStream(c.req.raw.body!) : undefined
      return ndjsonResponse(engine.read(input)) as any
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/write',
      tags: ['Sync'],
      summary: 'Write records to destination',
      description:
        'Reads NDJSON messages from the request body and writes them to the destination. Pipe /read output as input.',
      request: {
        headers: XSyncParamsHeader,
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
          description: 'Invalid params or missing body',
        },
      },
    }),
    async (c) => {
      const params = requireSyncParams(c.req.header('X-Sync-Params'))
      const engine = await createEngineFromParams(params, resolver, {})
      if (!hasBody(c)) {
        return c.json({ error: 'Request body required for /write' }, 400)
      }
      const messages = parseNdjsonStream<Message>(c.req.raw.body!)
      return ndjsonResponse(engine.write(messages)) as any
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/run',
      tags: ['Sync'],
      summary: 'Run full sync (read → write pipeline)',
      description:
        'Executes a complete source→destination sync. Streams NDJSON messages. Optional NDJSON body provides catalog/state/event input.',
      request: { headers: XSyncParamsHeader },
      responses: {
        200: {
          content: { 'application/x-ndjson': { schema: NdjsonSchema } },
          description: 'NDJSON stream of sync messages',
        },
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Invalid params',
        },
      },
    }),
    async (c) => {
      const params = requireSyncParams(c.req.header('X-Sync-Params'))
      const engine = await createEngineFromParams(params, resolver, {})
      const input = hasBody(c) ? parseNdjsonStream(c.req.raw.body!) : undefined
      return ndjsonResponse(engine.run(input)) as any
    }
  )

  // ── OpenAPI spec + Swagger UI ───────────────────────────────────

  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'Stripe Sync Stateless API',
      version: '1.0.0',
      description:
        'Stripe Sync Engine stateless API — one-shot source/destination sync over HTTP. ' +
        'All sync endpoints accept configuration via the X-Sync-Params header (JSON-encoded SyncParams).',
    },
  })

  app.get('/docs', swaggerUI({ url: '/openapi.json' }))

  return app
}
