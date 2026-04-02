import { OpenAPIHono, createRoute } from '@stripe/sync-hono-zod-openapi'
import { z } from 'zod'
import { apiReference } from '@scalar/hono-api-reference'
import { HTTPException } from 'hono/http-exception'
import pg from 'pg'
import type { Message, DestinationOutput, ConnectorResolver, SyncParams } from '../lib/index.js'
import {
  createEngineFromParams,
  readonlyStateStore,
  parseNdjsonStream,
  PipelineConfig,
} from '../lib/index.js'
import { endpointTable, addDiscriminators, injectConnectorSchemas } from './openapi-utils.js'
import {
  Message as MessageSchema,
  DestinationOutput as DestinationOutputSchema,
  CatalogMessage as CatalogMessageSchema,
} from '@stripe/sync-protocol'
import { takeStateCheckpoints } from '../lib/pipeline.js'
import { ndjsonResponse } from '@stripe/sync-ts-cli/ndjson'
import { logger } from '../logger.js'
import {
  sslConfigFromConnectionString,
  stripSslParams,
  withPgConnectProxy,
} from '@stripe/sync-util-postgres'

// ── Helpers ─────────────────────────────────────────────────────

function syncRequestContext(params: SyncParams) {
  return {
    sourceName: params.pipeline.source.type,
    destinationName: params.pipeline.destination.type,
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
      return c.json({ error: err.message }, err.status)
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
      pipeline = PipelineConfig.parse(JSON.parse(pipelineHeader))
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

  // ── Shared header param schemas ─────────────────────────────────

  const xPipelineHeader = z
    .string()
    .optional()
    .meta({
      description:
        'JSON-encoded PipelineConfig: { source: { type, ...config }, destination: { type, ...config }, streams }',
      example: JSON.stringify({
        source: { type: 'stripe', api_key: 'sk_test_...' },
        destination: { type: 'postgres', connection_string: 'postgres://localhost/db' },
        streams: [{ name: 'products' }],
      }),
    })

  const xStateHeader = z
    .string()
    .optional()
    .meta({
      description:
        'JSON-encoded per-stream cursor state. Engine uses this if present, falls back to StateStore.',
      example: JSON.stringify({ products: { cursor: 'prod_xyz' } }),
    })

  const xCheckpointLimitHeader = z.coerce.number().int().positive().optional().meta({
    description:
      'When set, stops streaming after N state checkpoint messages. Enables page-at-a-time sync.',
    example: '1',
  })

  const pipelineHeaders = z.object({ 'x-pipeline': xPipelineHeader })
  const allSyncHeaders = z.object({
    'x-pipeline': xPipelineHeader,
    'x-state': xStateHeader,
    'x-state-checkpoint-limit': xCheckpointLimitHeader,
  })

  const errorResponse = {
    description: 'Invalid params',
    content: {
      'application/json': { schema: z.object({ error: z.unknown() }) },
    },
  } as const

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
      requestParams: { header: pipelineHeaders },
      responses: {
        200: {
          description: 'Setup complete',
          content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
        },
        400: errorResponse,
      },
    }),
    async (c) => {
      const params = parseSyncParams(c)
      const context = { path: '/setup', ...syncRequestContext(params) }
      const startedAt = Date.now()
      logger.info(context, 'Engine API /setup started')
      const engine = await createEngineFromParams(params.pipeline, resolver, readonlyStateStore())
      try {
        const result = await engine.setup()
        logger.info(
          { ...context, durationMs: Date.now() - startedAt },
          'Engine API /setup completed'
        )
        return c.json(result ?? {}, 200)
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
      requestParams: { header: pipelineHeaders },
      responses: {
        204: { description: 'Teardown complete' },
        400: errorResponse,
      },
    }),
    async (c) => {
      const params = parseSyncParams(c)
      const engine = await createEngineFromParams(params.pipeline, resolver, readonlyStateStore())
      await engine.teardown()
      return c.body(null, 204)
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
      requestParams: { header: pipelineHeaders },
      responses: {
        200: {
          description: 'Connection check result',
          content: {
            'application/json': {
              schema: z.object({
                source: z.object({
                  status: z.enum(['succeeded', 'failed']),
                  message: z.string().optional(),
                }),
                destination: z.object({
                  status: z.enum(['succeeded', 'failed']),
                  message: z.string().optional(),
                }),
              }),
            },
          },
        },
        400: errorResponse,
      },
    }),
    async (c) => {
      const params = parseSyncParams(c)
      const engine = await createEngineFromParams(params.pipeline, resolver, readonlyStateStore())
      const result = await engine.check()
      return c.json(result, 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'discover',
      method: 'post',
      path: '/discover',
      tags: ['Stateless Sync API'],
      summary: 'Discover available streams',
      description:
        'Returns the catalog of available streams for the configured source. Each stream includes its name, primary key, and optional JSON schema.',
      requestParams: { header: pipelineHeaders },
      responses: {
        200: {
          description: 'Available streams',
          content: {
            'application/json': {
              schema: CatalogMessageSchema,
            },
          },
        },
        400: errorResponse,
      },
    }),
    async (c) => {
      const params = parseSyncParams(c)
      const source = await resolver.resolveSource(params.pipeline.source.type)
      const { type: _, ...sourceConfig } = params.pipeline.source
      const config = z.fromJSONSchema(source.spec().config).parse(sourceConfig)
      const catalog = await source.discover({ config: config as Record<string, unknown> })
      return c.json(catalog, 200)
    }
  )

  // For streaming NDJSON routes the handler returns a raw Response (not c.json),
  // so we cast to `any` to satisfy the typed route handler constraint.

  app.openapi(
    createRoute({
      operationId: 'read',
      method: 'post',
      path: '/read',
      tags: ['Stateless Sync API'],
      summary: 'Read records from source',
      description:
        'Streams NDJSON messages (records, state, catalog). Optional NDJSON body provides live events as input.',
      requestParams: { header: allSyncHeaders },
      responses: {
        200: {
          description: 'NDJSON stream of sync messages',
          content: { 'application/x-ndjson': { schema: MessageSchema } },
        },
        400: errorResponse,
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (c: any) => {
      const params = parseSyncParams(c)
      const inputPresent = hasBody(c)
      const context = { path: '/read', inputPresent, ...syncRequestContext(params) }
      const startedAt = Date.now()
      logger.info(context, 'Engine API /read started')
      const engine = await createEngineFromParams(
        params.pipeline,
        resolver,
        readonlyStateStore(params.state)
      )

      const input = inputPresent ? parseNdjsonStream(c.req.raw.body!) : undefined
      let output: AsyncIterable<Message> = engine.read(input)
      if (params.stateCheckpointLimit) {
        output = takeStateCheckpoints<Message>(params.stateCheckpointLimit)(output)
      }
      return ndjsonResponse(logApiStream('Engine API /read', output, context, startedAt))
    }) as any
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
      requestParams: { header: pipelineHeaders },
      requestBody: {
        required: true,
        content: { 'application/x-ndjson': { schema: MessageSchema } },
      },
      responses: {
        200: {
          description: 'NDJSON stream of write result messages',
          content: { 'application/x-ndjson': { schema: DestinationOutputSchema } },
        },
        400: errorResponse,
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (c: any) => {
      const params = parseSyncParams(c)
      const context = { path: '/write', ...syncRequestContext(params) }
      if (!hasBody(c)) {
        logger.error(context, 'Engine API /write missing request body')
        return c.json({ error: 'Request body required for /write' }, 400)
      }
      const startedAt = Date.now()
      logger.info(context, 'Engine API /write started')
      const engine = await createEngineFromParams(params.pipeline, resolver, readonlyStateStore())
      const messages = parseNdjsonStream<Message>(c.req.raw.body!)
      return ndjsonResponse(
        logApiStream('Engine API /write', engine.write(messages), context, startedAt)
      )
    }) as any
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
      requestParams: { header: allSyncHeaders },
      responses: {
        200: {
          description: 'NDJSON stream of sync messages',
          content: { 'application/x-ndjson': { schema: DestinationOutputSchema } },
        },
        400: errorResponse,
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (c: any) => {
      const params = parseSyncParams(c)
      const stateStore = readonlyStateStore(params.state)
      const engine = await createEngineFromParams(params.pipeline, resolver, stateStore)

      const input = hasBody(c) ? parseNdjsonStream(c.req.raw.body!) : undefined
      let output: AsyncIterable<DestinationOutput> = engine.sync(input)
      if (params.stateCheckpointLimit) {
        output = takeStateCheckpoints<DestinationOutput>(params.stateCheckpointLimit)(output)
      }
      return ndjsonResponse(output)
    }) as any
  )

  app.openapi(
    createRoute({
      operationId: 'listConnectors',
      method: 'get',
      path: '/connectors',
      tags: ['Connectors'],
      summary: 'List available connectors and their config schemas',
      responses: {
        200: {
          description: 'Available connectors with their JSON Schema configs',
          content: {
            'application/json': {
              schema: z.object({
                sources: z.record(
                  z.string(),
                  z.object({ config_schema: z.record(z.string(), z.unknown()) })
                ),
                destinations: z.record(
                  z.string(),
                  z.object({ config_schema: z.record(z.string(), z.unknown()) })
                ),
              }),
            },
          },
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

  app.get('/openapi.json', (c) => {
    const spec = app.getOpenAPI31Document({
      info: {
        title: 'Stripe Sync Engine',
        version: '1.0.0',
        description:
          'Stripe Sync Engine — stateless, one-shot source/destination sync over HTTP.\nAll sync endpoints accept configuration via the `X-Pipeline` header (JSON-encoded PipelineConfig). Optional cursor state can be provided via `X-State`.',
      },
    }) as any

    injectConnectorSchemas(spec, resolver)
    addDiscriminators(spec)
    spec.info.description += '\n\n## Endpoints\n\n' + endpointTable(spec)
    return c.json(spec)
  })

  app.get('/docs', apiReference({ url: '/openapi.json' }))

  // ── Internal utilities ───────────────────────────────────────────────────────
  // NOTE: no HTTP auth on /internal/* — only safe on a trusted private network.

  app.post('/internal/query', async (c) => {
    const { connection_string, sql } = await c.req.json<{
      connection_string: string
      sql: string
    }>()
    const pool = new pg.Pool(
      withPgConnectProxy({
        connectionString: stripSslParams(connection_string),
        ssl: sslConfigFromConnectionString(connection_string),
      })
    )
    try {
      const result = await pool.query(sql)
      return c.json({ rows: result.rows, rowCount: result.rowCount })
    } finally {
      await pool.end()
    }
  })

  return app
}
