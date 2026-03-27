import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { apiReference } from '@scalar/hono-api-reference'
import { HTTPException } from 'hono/http-exception'
import type { Message, DestinationOutput, ConnectorResolver, SyncParams } from '../lib/index.js'
import {
  createEngineFromParams,
  noopStateStore,
  parseNdjsonStream,
  selectStateStore,
  PipelineParams,
} from '../lib/index.js'
import { takeStateCheckpoints } from '../lib/pipeline.js'
import { ndjsonResponse } from '@stripe/sync-ts-cli/ndjson'
import { logger } from '../logger.js'

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

function syncRequestContext(params: SyncParams) {
  return {
    sourceName: params.pipeline.source.name,
    destinationName: params.pipeline.destination.name,
    configuredStreamCount: params.pipeline.streams?.length ?? 0,
    configuredStreams: params.pipeline.streams?.map((stream) => stream.name) ?? [],
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
    logger.info({ ...context, itemCount, durationMs: Date.now() - startedAt }, `${label} completed`)
  } catch (error) {
    logger.error(
      { ...context, itemCount, durationMs: Date.now() - startedAt, err: error },
      `${label} failed`
    )
    throw error
  }
}

// ── Shared schemas ──────────────────────────────────────────────

const XPipelineHeader = z.object({
  'x-pipeline': z
    .string()
    .optional()
    .openapi({
      description:
        'JSON-encoded PipelineParams: { source: { name, ...config }, destination: { name, ...config }, streams }',
      example: JSON.stringify({
        source: { name: 'stripe', api_key: 'sk_test_...' },
        destination: { name: 'postgres', connection_string: 'postgres://localhost/db' },
        streams: [{ name: 'products' }],
      }),
    }),
})

const XStateHeader = z.object({
  'x-state': z
    .string()
    .optional()
    .openapi({
      description:
        'JSON-encoded per-stream cursor state. Engine uses this if present, falls back to StateStore.',
      example: JSON.stringify({ products: { cursor: 'prod_xyz' } }),
    }),
})

const XStateCheckpointLimitHeader = z.object({
  'x-state-checkpoint-limit': z.coerce.number().int().positive().optional().openapi({
    description:
      'When set, stops streaming after N state checkpoint messages. Enables page-at-a-time sync.',
    example: '1',
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
    logger.error({ err }, 'Unhandled error')
    return c.json({ error: 'Internal server error' }, 500)
  })

  /** Node.js 24 sets c.req.raw.body to a non-null empty ReadableStream even for bodyless POSTs. */
  function hasBody(c: { req: { header: (name: string) => string | undefined } }): boolean {
    const cl = c.req.header('Content-Length')
    if (cl !== undefined) return Number(cl) > 0
    if (c.req.header('Transfer-Encoding')) return true
    return false
  }

  /** Parse all sync headers (X-Pipeline, X-State, X-State-Checkpoint-Limit) into SyncParams. */
  function parseSyncParams(c: {
    req: { header: (name: string) => string | undefined }
  }): SyncParams {
    const pipelineHeader = c.req.header('X-Pipeline')
    if (!pipelineHeader) {
      throw new HTTPException(400, { message: 'Missing X-Pipeline header' })
    }
    let pipeline
    try {
      pipeline = PipelineParams.parse(JSON.parse(pipelineHeader))
    } catch {
      throw new HTTPException(400, { message: 'Invalid JSON in X-Pipeline header' })
    }

    const stateHeader = c.req.header('X-State')
    let state: Record<string, unknown> | undefined
    if (stateHeader) {
      try {
        state = JSON.parse(stateHeader)
      } catch {
        throw new HTTPException(400, { message: 'Invalid JSON in X-State header' })
      }
    }

    const limitHeader = c.req.header('X-State-Checkpoint-Limit')
    const stateCheckpointLimit = limitHeader ? Number(limitHeader) : undefined

    return { pipeline, state, stateCheckpointLimit }
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
      request: { headers: XPipelineHeader },
      responses: {
        204: { description: 'Setup complete' },
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Invalid params',
        },
      },
    }),
    async (c) => {
      const params = parseSyncParams(c)
      const context = { path: '/setup', ...syncRequestContext(params) }
      const startedAt = Date.now()
      logger.info(context, 'Engine API /setup started')
      const engine = await createEngineFromParams(params.pipeline, resolver, noopStateStore())
      try {
        await engine.setup()
        logger.info(
          { ...context, durationMs: Date.now() - startedAt },
          'Engine API /setup completed'
        )
        return c.body(null, 204) as any
      } catch (error) {
        logger.error(
          { ...context, durationMs: Date.now() - startedAt, err: error },
          'Engine API /setup failed'
        )
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
      request: { headers: XPipelineHeader },
      responses: {
        204: { description: 'Teardown complete' },
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Invalid params',
        },
      },
    }),
    async (c) => {
      const params = parseSyncParams(c)
      const engine = await createEngineFromParams(params.pipeline, resolver, noopStateStore())
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
      request: { headers: XPipelineHeader },
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
      const params = parseSyncParams(c)
      const engine = await createEngineFromParams(params.pipeline, resolver, noopStateStore())
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
      request: {
        headers: XPipelineHeader.merge(XStateHeader).merge(XStateCheckpointLimitHeader),
      },
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
      const params = parseSyncParams(c)
      const inputPresent = hasBody(c)
      const context = { path: '/read', inputPresent, ...syncRequestContext(params) }
      const startedAt = Date.now()
      logger.info(context, 'Engine API /read started')
      const engine = await createEngineFromParams(
        params.pipeline,
        resolver,
        noopStateStore(),
        params.state
      )
      const input = inputPresent ? parseNdjsonStream(c.req.raw.body!) : undefined
      let output: AsyncIterable<Message> = engine.read(input)
      if (params.stateCheckpointLimit) {
        output = takeStateCheckpoints<Message>(params.stateCheckpointLimit)(output)
      }
      return ndjsonResponse(logApiStream('Engine API /read', output, context, startedAt)) as any
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
        headers: XPipelineHeader,
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
      const params = parseSyncParams(c)
      const context = { path: '/write', ...syncRequestContext(params) }
      if (!hasBody(c)) {
        logger.error(context, 'Engine API /write missing request body')
        return c.json({ error: 'Request body required for /write' }, 400)
      }
      const startedAt = Date.now()
      logger.info(context, 'Engine API /write started')
      const stateStore = await selectStateStore(params.pipeline)
      const engine = await createEngineFromParams(params.pipeline, resolver, stateStore)
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
      request: {
        headers: XPipelineHeader.merge(XStateHeader).merge(XStateCheckpointLimitHeader),
      },
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
      const params = parseSyncParams(c)
      const stateStore = await selectStateStore(params.pipeline)
      const engine = await createEngineFromParams(
        params.pipeline,
        resolver,
        stateStore,
        params.state
      )
      const input = hasBody(c) ? parseNdjsonStream(c.req.raw.body!) : undefined
      let output: AsyncIterable<DestinationOutput> = engine.sync(input)
      if (params.stateCheckpointLimit) {
        output = takeStateCheckpoints<DestinationOutput>(params.stateCheckpointLimit)(output)
      }
      return ndjsonResponse(closeAfter(output, () => stateStore.close?.())) as any
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
          'Stripe Sync Engine — stateless, one-shot source/destination sync over HTTP.\nAll sync endpoints accept configuration via the `X-Pipeline` header (JSON-encoded PipelineParams). Optional cursor state can be provided via `X-State`.',
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

    // PipelineParams schema
    doc.components.schemas['PipelineParams'] = {
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
      },
    }

    spec.info.description += '\n\n## Endpoints\n\n' + endpointTable(spec)
    return c.json(spec)
  })

  app.get('/docs', apiReference({ url: '/openapi.json' }))

  return app
}
