import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { apiReference } from '@scalar/hono-api-reference'
import { HTTPException } from 'hono/http-exception'
import type { Message, ConnectorResolver, SyncParams as SyncParamsType } from '../lib/index.js'
import {
  createEngineFromParams,
  noopStateStore,
  parseNdjsonStream,
  selectStateStore,
  SyncParams,
} from '../lib/index.js'
import { ndjsonResponse } from '@stripe/sync-ts-cli/ndjson'

// ── Helpers ─────────────────────────────────────────────────────

function endpointTable(spec: { paths?: Record<string, unknown> }) {
  const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])
  const rows = Object.entries(spec.paths ?? {}).flatMap(([path, methods]) =>
    Object.entries(methods as Record<string, { summary?: string }>)
      .filter(([m]) => HTTP_METHODS.has(m))
      .map(([method, op]) => `| ${method.toUpperCase()} | ${path} | ${op.summary ?? ''} |`)
  )
  return ['| Method | Path | Summary |', '|--------|------|---------|', ...rows].join('\n')
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function syncRequestContext(params: SyncParamsType) {
  return {
    sourceName: params.source.name,
    destinationName: params.destination.name,
    configuredStreamCount: params.streams?.length ?? 0,
    configuredStreams: params.streams?.map((stream) => stream.name) ?? [],
  }
}

async function* logApiStream<T>(
  label: string,
  iter: AsyncIterable<T>,
  context: Record<string, unknown>,
  startedAt = Date.now()
): AsyncIterable<T> {
  let itemCount = 0
  try {
    for await (const item of iter) {
      itemCount++
      yield item
    }
    console.info({
      msg: `${label} completed`,
      ...context,
      itemCount,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    console.error({
      msg: `${label} failed`,
      ...context,
      itemCount,
      durationMs: Date.now() - startedAt,
      error: formatError(error),
    })
    throw error
  }
}

// ── Shared schemas ──────────────────────────────────────────────

const XSyncParamsHeader = z.object({
  'x-sync-params': z
    .string()
    .optional()
    .openapi({
      description:
        'JSON-encoded SyncParams: { source: { name, ...config }, destination: { name, ...config }, streams }',
      example: JSON.stringify({
        source: { name: 'stripe', api_key: 'sk_test_...' },
        destination: { name: 'postgres', connection_string: 'postgres://localhost/db' },
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
  function hasBody(c: { req: { header: (name: string) => string | undefined } }): boolean {
    const cl = c.req.header('Content-Length')
    if (cl !== undefined) return Number(cl) > 0
    if (c.req.header('Transfer-Encoding')) return true
    return false
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

  /** Wraps an async iterable to call `fn()` after iteration completes or throws. */
  async function* closeAfter<T>(
    iter: AsyncIterable<T>,
    fn: () => Promise<void> | void
  ): AsyncIterable<T> {
    try {
      yield* iter
    } finally {
      await fn()
    }
  }

  // ── Routes ─────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      operationId: 'health',
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
      operationId: 'setup',
      method: 'post',
      path: '/setup',
      tags: ['Stateless Sync API'],
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
      const context = { path: '/setup', ...syncRequestContext(params) }
      const startedAt = Date.now()
      console.info({ msg: 'Engine API /setup started', ...context })
      const engine = await createEngineFromParams(params, resolver, noopStateStore())
      try {
        await engine.setup()
        console.info({
          msg: 'Engine API /setup completed',
          ...context,
          durationMs: Date.now() - startedAt,
        })
        return c.body(null, 204) as any
      } catch (error) {
        console.error({
          msg: 'Engine API /setup failed',
          ...context,
          durationMs: Date.now() - startedAt,
          error: formatError(error),
        })
        throw error
      }
    }
  )

  app.openapi(
    createRoute({
      operationId: 'teardown',
      method: 'post',
      path: '/teardown',
      tags: ['Stateless Sync API'],
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
      const engine = await createEngineFromParams(params, resolver, noopStateStore())
      await engine.teardown()
      return c.body(null, 204) as any
    }
  )

  app.openapi(
    createRoute({
      operationId: 'check',
      method: 'get',
      path: '/check',
      tags: ['Stateless Sync API'],
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
      const engine = await createEngineFromParams(params, resolver, noopStateStore())
      const result = await engine.check()
      return c.json(result, 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'read',
      method: 'post',
      path: '/read',
      tags: ['Stateless Sync API'],
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
      const inputPresent = hasBody(c)
      const context = { path: '/read', inputPresent, ...syncRequestContext(params) }
      const startedAt = Date.now()
      console.info({ msg: 'Engine API /read started', ...context })
      const engine = await createEngineFromParams(params, resolver, noopStateStore())
      const input = inputPresent ? parseNdjsonStream(c.req.raw.body!) : undefined
      return ndjsonResponse(
        logApiStream('Engine API /read', engine.read(input), context, startedAt)
      ) as any
    }
  )

  app.openapi(
    createRoute({
      operationId: 'write',
      method: 'post',
      path: '/write',
      tags: ['Stateless Sync API'],
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
      const context = { path: '/write', ...syncRequestContext(params) }
      if (!hasBody(c)) {
        console.error({ msg: 'Engine API /write missing request body', ...context })
        return c.json({ error: 'Request body required for /write' }, 400)
      }
      const startedAt = Date.now()
      console.info({ msg: 'Engine API /write started', ...context })
      const stateStore = await selectStateStore(params)
      const engine = await createEngineFromParams(params, resolver, stateStore)
      const messages = parseNdjsonStream<Message>(c.req.raw.body!)
      return ndjsonResponse(
        closeAfter(
          logApiStream('Engine API /write', engine.write(messages), context, startedAt),
          () => stateStore.close?.()
        )
      ) as any
    }
  )

  app.openapi(
    createRoute({
      operationId: 'sync',
      method: 'post',
      path: '/sync',
      tags: ['Stateless Sync API'],
      summary: 'Run sync pipeline (read → write)',
      description:
        'Without a request body, reads from the source connector and writes to the destination (backfill mode). ' +
        'With an NDJSON request body, uses the provided messages as input instead of reading from the source (push mode — e.g. piped webhook events).',
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
      const stateStore = await selectStateStore(params)
      const engine = await createEngineFromParams(params, resolver, stateStore)
      const input = hasBody(c) ? parseNdjsonStream(c.req.raw.body!) : undefined
      return ndjsonResponse(closeAfter(engine.sync(input), () => stateStore.close?.())) as any
    }
  )

  // ── Connectors ─────────────────────────────────────────────────

  const ConnectorsResponseSchema = z.object({
    sources: z.record(z.string(), z.object({ config_schema: z.record(z.string(), z.unknown()) })),
    destinations: z.record(
      z.string(),
      z.object({ config_schema: z.record(z.string(), z.unknown()) })
    ),
  })

  app.openapi(
    createRoute({
      operationId: 'listConnectors',
      method: 'get',
      path: '/connectors',
      tags: ['Connectors'],
      summary: 'List available connectors and their config schemas',
      responses: {
        200: {
          content: { 'application/json': { schema: ConnectorsResponseSchema } },
          description: 'Available connectors with their JSON Schema configs',
        },
      },
    }),
    (c) => {
      const sources = Object.fromEntries(
        [...resolver.sources()].map(([name, r]) => [name, { config_schema: r.rawConfigJsonSchema }])
      )
      const destinations = Object.fromEntries(
        [...resolver.destinations()].map(([name, r]) => [
          name,
          { config_schema: r.rawConfigJsonSchema },
        ])
      )
      return c.json({ sources, destinations }, 200)
    }
  )

  // ── OpenAPI spec + Swagger UI ───────────────────────────────────

  function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1)
  }

  function connectorSchemaName(name: string, role: 'Source' | 'Destination'): string {
    // e.g. "stripe" → "Stripe", "google-sheets" → "GoogleSheets"
    const pascal = name
      .split(/[-_]/)
      .map((w) => capitalize(w))
      .join('')
    return `${pascal}${role}Config`
  }

  app.get('/openapi.json', (c) => {
    const spec = app.getOpenAPIDocument({
      openapi: '3.0.0',
      info: {
        title: 'Stripe Sync Engine',
        version: '1.0.0',
        description:
          'Stripe Sync Engine — stateless, one-shot source/destination sync over HTTP.\nAll sync endpoints accept configuration via the `X-Sync-Params` header (JSON-encoded SyncParams).',
      },
    })

    // Inject typed connector config schemas into OpenAPI components
    const doc = spec as any
    if (!doc.components) doc.components = {}
    if (!doc.components.schemas) doc.components.schemas = {}

    // Individual source config variants
    for (const [name, r] of resolver.sources()) {
      const schema = JSON.parse(JSON.stringify(r.rawConfigJsonSchema))
      schema.properties = { name: { type: 'string', enum: [name] }, ...(schema.properties ?? {}) }
      schema.required = ['name', ...(schema.required ?? [])]
      doc.components.schemas[connectorSchemaName(name, 'Source')] = schema
    }

    // Individual destination config variants
    for (const [name, r] of resolver.destinations()) {
      const schema = JSON.parse(JSON.stringify(r.rawConfigJsonSchema))
      schema.properties = { name: { type: 'string', enum: [name] }, ...(schema.properties ?? {}) }
      schema.required = ['name', ...(schema.required ?? [])]
      doc.components.schemas[connectorSchemaName(name, 'Destination')] = schema
    }

    // SourceConfig = discriminated union of all source variants
    const sourceNames = [...resolver.sources().keys()]
    if (sourceNames.length > 0) {
      doc.components.schemas['SourceConfig'] = {
        discriminator: { propertyName: 'name' },
        oneOf: sourceNames.map((n) => ({
          $ref: `#/components/schemas/${connectorSchemaName(n, 'Source')}`,
        })),
      }
    }

    // DestinationConfig = discriminated union of all destination variants
    const destNames = [...resolver.destinations().keys()]
    if (destNames.length > 0) {
      doc.components.schemas['DestinationConfig'] = {
        discriminator: { propertyName: 'name' },
        oneOf: destNames.map((n) => ({
          $ref: `#/components/schemas/${connectorSchemaName(n, 'Destination')}`,
        })),
      }
    }

    // SyncParams schema
    doc.components.schemas['SyncParams'] = {
      type: 'object',
      required: ['source', 'destination'],
      properties: {
        source:
          sourceNames.length > 0
            ? { $ref: '#/components/schemas/SourceConfig' }
            : {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
                additionalProperties: true,
              },
        destination:
          destNames.length > 0
            ? { $ref: '#/components/schemas/DestinationConfig' }
            : {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
                additionalProperties: true,
              },
        streams: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              sync_mode: { type: 'string', enum: ['incremental', 'full_refresh'] },
              fields: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        state: { type: 'object', additionalProperties: true },
      },
    }

    spec.info.description += '\n\n## Endpoints\n\n' + endpointTable(spec)
    return c.json(spec)
  })

  app.get('/docs', apiReference({ url: '/openapi.json' }))

  return app
}
