import { OpenAPIHono, createRoute } from '@stripe/sync-hono-zod-openapi'
import { z } from 'zod'
import { apiReference } from '@scalar/hono-api-reference'
import { HTTPException } from 'hono/http-exception'
import pg from 'pg'
import type { Message, DestinationOutput, ConnectorResolver, SyncParams } from '../lib/index.js'
import {
  createEngine,
  PipelineConfig,
  parseNdjsonStream,
  ConnectorInfo,
  ConnectorListItem,
} from '../lib/index.js'
import { endpointTable, addDiscriminators, injectConnectorSchemas } from './openapi-utils.js'
import {
  Message as MessageSchema,
  DestinationOutput as DestinationOutputSchema,
} from '@stripe/sync-protocol'
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

export async function createApp(resolver: ConnectorResolver) {
  const engine = await createEngine(resolver)

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

  /** Parse sync headers (X-Pipeline, X-State) and query params (state_limit, time_limit) into SyncParams. */
  function parseSyncParams(c: {
    req: {
      header: (name: string) => string | undefined
      query: (name: string) => string | undefined
    }
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

    const stateLimitStr = c.req.query('state_limit')
    const stateLimit = stateLimitStr ? Number(stateLimitStr) : undefined
    const timeLimitStr = c.req.query('time_limit')
    const timeLimit = timeLimitStr ? Number(timeLimitStr) : undefined

    return { pipeline, state, stateLimit, timeLimit }
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

  const pipelineHeaders = z.object({ 'x-pipeline': xPipelineHeader })
  const allSyncHeaders = z.object({
    'x-pipeline': xPipelineHeader,
    'x-state': xStateHeader,
  })

  const syncQueryParams = z.object({
    state_limit: z.coerce.number().int().positive().optional().meta({
      description: 'Stop streaming after N state messages.',
      example: '100',
    }),
    time_limit: z.coerce.number().positive().optional().meta({
      description: 'Stop streaming after N seconds.',
      example: '10',
    }),
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
      operationId: 'pipeline_setup',
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
      try {
        const result = await engine.pipeline_setup(params.pipeline)
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
      operationId: 'pipeline_teardown',
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
      await engine.pipeline_teardown(params.pipeline)
      return c.body(null, 204)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'pipeline_check',
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
      const result = await engine.pipeline_check(params.pipeline)
      return c.json(result, 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'source_discover',
      method: 'post',
      path: '/discover',
      tags: ['Stateless Sync API'],
      summary: 'Discover available streams',
      description: 'Streams NDJSON messages (catalog, logs, traces) for the configured source.',
      requestParams: { header: pipelineHeaders },
      responses: {
        200: {
          description: 'NDJSON stream of discover messages',
          content: { 'application/x-ndjson': { schema: MessageSchema } },
        },
        400: errorResponse,
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((c: any) => {
      const params = parseSyncParams(c)
      return ndjsonResponse(engine.source_discover(params.pipeline.source))
    }) as any
  )

  // For streaming NDJSON routes the handler returns a raw Response (not c.json),
  // so we cast to `any` to satisfy the typed route handler constraint.

  app.openapi(
    createRoute({
      operationId: 'pipeline_read',
      method: 'post',
      path: '/read',
      tags: ['Stateless Sync API'],
      summary: 'Read records from source',
      description:
        'Streams NDJSON messages (records, state, catalog). Optional NDJSON body provides live events as input.',
      requestParams: { header: allSyncHeaders, query: syncQueryParams },
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

      const input = inputPresent ? parseNdjsonStream(c.req.raw.body!) : undefined
      const output = engine.pipeline_read(
        params.pipeline,
        { state: params.state, stateLimit: params.stateLimit, timeLimit: params.timeLimit },
        input
      )
      return ndjsonResponse(logApiStream('Engine API /read', output, context, startedAt))
    }) as any
  )

  app.openapi(
    createRoute({
      operationId: 'pipeline_write',
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
      const messages = parseNdjsonStream<Message>(c.req.raw.body!)
      return ndjsonResponse(
        logApiStream(
          'Engine API /write',
          engine.pipeline_write(params.pipeline, messages),
          context,
          startedAt
        )
      )
    }) as any
  )

  app.openapi(
    createRoute({
      operationId: 'pipeline_sync',
      method: 'post',
      path: '/sync',
      tags: ['Stateless Sync API'],
      summary: 'Run sync pipeline (read → write)',
      description:
        'Without a request body, reads from the source connector and writes to the destination (backfill mode). ' +
        'With an NDJSON request body, uses the provided messages as input instead of reading from the source (push mode — e.g. piped webhook events).',
      requestParams: { header: allSyncHeaders, query: syncQueryParams },
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
      const input = hasBody(c) ? parseNdjsonStream(c.req.raw.body!) : undefined
      const output = engine.pipeline_sync(
        params.pipeline,
        { state: params.state, stateLimit: params.stateLimit, timeLimit: params.timeLimit },
        input
      )
      return ndjsonResponse(output)
    }) as any
  )

  app.openapi(
    createRoute({
      operationId: 'meta_sources_list',
      method: 'get',
      path: '/meta/sources',
      tags: ['Meta'],
      summary: 'List available source connectors',
      responses: {
        200: {
          description: 'Available source connectors with their JSON Schema configs',
          content: {
            'application/json': {
              schema: z.object({ data: z.array(ConnectorListItem) }),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await engine.meta_sources_list(), 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'meta_source',
      method: 'get',
      path: '/meta/sources/:type',
      tags: ['Meta'],
      summary: 'Get source connector spec',
      requestParams: { path: z.object({ type: z.string() }) },
      responses: {
        200: {
          description: 'Source connector spec',
          content: { 'application/json': { schema: ConnectorInfo } },
        },
        404: { description: 'Source connector not found' },
      },
    }),
    async (c) => {
      const { type } = c.req.valid('param')
      try {
        return c.json(await engine.meta_source(type), 200)
      } catch {
        return c.json({ error: `Unknown source connector: ${type}` }, 404)
      }
    }
  )

  app.openapi(
    createRoute({
      operationId: 'meta_destinations_list',
      method: 'get',
      path: '/meta/destinations',
      tags: ['Meta'],
      summary: 'List available destination connectors',
      responses: {
        200: {
          description: 'Available destination connectors with their JSON Schema configs',
          content: {
            'application/json': {
              schema: z.object({ data: z.array(ConnectorListItem) }),
            },
          },
        },
      },
    }),
    async (c) => {
      return c.json(await engine.meta_destinations_list(), 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'meta_destination',
      method: 'get',
      path: '/meta/destinations/:type',
      tags: ['Meta'],
      summary: 'Get destination connector spec',
      requestParams: { path: z.object({ type: z.string() }) },
      responses: {
        200: {
          description: 'Destination connector spec',
          content: { 'application/json': { schema: ConnectorInfo } },
        },
        404: { description: 'Destination connector not found' },
      },
    }),
    async (c) => {
      const { type } = c.req.valid('param')
      try {
        return c.json(await engine.meta_destination(type), 200)
      } catch {
        return c.json({ error: `Unknown destination connector: ${type}` }, 404)
      }
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
