import os from 'node:os'
import { OpenAPIHono, createRoute } from '@stripe/sync-hono-zod-openapi'
import { z } from 'zod'
import { apiReference } from '@scalar/hono-api-reference'
import { HTTPException } from 'hono/http-exception'
import pg from 'pg'
import type { Message, ConnectorResolver } from '../lib/index.js'
import {
  createEngine,
  createConnectorSchemas,
  ConnectorInfo,
  ConnectorListItem,
} from '../lib/index.js'
import { endpointTable, patchControlMessageSchema } from './openapi-utils.js'
import {
  Message as MessageSchema,
  DiscoverOutput as DiscoverOutputSchema,
  DestinationOutput as DestinationOutputSchema,
  SyncOutput as SyncOutputSchema,
  CheckOutput as CheckOutputSchema,
  SetupOutput as SetupOutputSchema,
  TeardownOutput as TeardownOutputSchema,
  SyncState,
  emptySyncState,
} from '@stripe/sync-protocol'

// Raw $refs for NDJSON content schemas — avoids zod-openapi generating *Output
// duplicates when the same Zod schema appears in both request and response positions.
// The actual Zod schemas are registered once via components in getOpenAPI31Document.
const ndjsonRef = {
  Message: { $ref: '#/components/schemas/Message' },
  DiscoverOutput: { $ref: '#/components/schemas/DiscoverOutput' },
  DestinationOutput: { $ref: '#/components/schemas/DestinationOutput' },
  SyncOutput: { $ref: '#/components/schemas/SyncOutput' },
  CheckOutput: { $ref: '#/components/schemas/CheckOutput' },
  SetupOutput: { $ref: '#/components/schemas/SetupOutput' },
  TeardownOutput: { $ref: '#/components/schemas/TeardownOutput' },
}
import { ndjsonResponse } from '@stripe/sync-ts-cli/ndjson'
import { log } from '../logger.js'
import {
  sslConfigFromConnectionString,
  stripSslParams,
  withPgConnectProxy,
} from '@stripe/sync-util-postgres'
import { syncRequestContext, logApiStream, createConnectionAbort } from './helpers.js'
import {
  ENGINE_REQUEST_ID_HEADER,
  getEngineRequestId,
  runWithEngineRequestContext,
} from '../request-context.js'

// ── Helpers ─────────────────────────────────────────────────────

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
    const engineRequestId = getEngineRequestId()
    if (err instanceof HTTPException) {
      if (engineRequestId) c.header(ENGINE_REQUEST_ID_HEADER, engineRequestId)
      return c.json({ error: err.message }, err.status)
    }
    log.error({ err }, 'Unhandled error')
    if (engineRequestId) c.header(ENGINE_REQUEST_ID_HEADER, engineRequestId)
    return c.json({ error: 'Internal server error' }, 500)
  })

  app.use('*', async (c, next) => {
    const engineRequestId = crypto.randomUUID()
    const action_id = c.req.header('X-Action-Id')?.trim() || null
    const run_id = new URL(c.req.url).searchParams.get('run_id')
    await runWithEngineRequestContext({ engineRequestId, action_id, run_id }, async () => {
      const start = Date.now()
      log.info({ method: c.req.method, path: c.req.path }, 'request start')
      await next()

      c.res.headers.set(ENGINE_REQUEST_ID_HEADER, engineRequestId)
      let error: string | undefined
      if (c.res.status >= 400) {
        try {
          const body = (await c.res.clone().json()) as { error: unknown }
          error = typeof body.error === 'string' ? body.error : JSON.stringify(body.error)
        } catch {
          // non-JSON error body, skip
        }
      }
      const level = c.res.status >= 200 && c.res.status < 300 ? 'info' : 'warn'
      log[level](
        {
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durationMs: Date.now() - start,
          error,
        },
        'request end'
      )
    })
  })

  // ── JSON body schemas ────────────────────────────────────────

  const {
    PipelineConfig: TypedPipelineConfig,
    sourceConfigNames,
    destConfigNames,
  } = createConnectorSchemas(resolver)

  const pipelineRequestBody = z.object({
    pipeline: TypedPipelineConfig,
    only: z.enum(['source', 'destination']).optional().meta({
      description:
        'Run only the source or destination side. Useful for optimistic destination setup or isolating a connector when debugging.',
    }),
  })

  const sourceRequestBody = z.object({
    source: z.object({ type: z.string() }).catchall(z.unknown()).meta({
      description: 'Source config ({ type, ...config })',
    }),
  })

  const syncRequestBody = z.object({
    pipeline: TypedPipelineConfig,
    time_limit: z.number().positive().optional().meta({
      description: 'Stop streaming after N seconds.',
      example: 300,
    }),
    soft_time_limit: z
      .number()
      .positive()
      .optional()
      .meta({
        description:
          'Soft wall-clock deadline in seconds. Stops reading from the source ' +
          'between messages; the destination continues to drain and flush until ' +
          'time_limit fires.',
        example: 150,
      }),
    run_id: z.string().optional().meta({
      description: 'Optional sync run identifier used to track bounded sync progress.',
      example: 'run_demo',
    }),
    stdin: z.array(MessageSchema).optional().meta({
      description:
        'Optional array of input messages (push mode). Without stdin, reads from the source connector (backfill mode).',
    }),
    state: SyncState.optional().meta({
      description:
        'SyncState ({ source, destination, sync_run }). Falls back to empty state if invalid.',
    }),
  })

  const writeRequestBody = z.object({
    pipeline: TypedPipelineConfig,
    stdin: z.array(MessageSchema).meta({
      description: 'Array of messages to write to the destination.',
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
          content: {
            'application/json': {
              schema: z.object({
                ok: z.literal(true),
                hostname: z.string(),
                commit: z.string().optional(),
                commit_url: z.string().optional(),
                build_date: z.string().optional(),
              }),
            },
          },
          description: 'Server is healthy',
        },
      },
    }),
    (c) =>
      c.json(
        {
          ok: true as const,
          hostname: os.hostname(),
          commit: process.env.GIT_COMMIT,
          commit_url: process.env.COMMIT_URL,
          build_date: process.env.BUILD_DATE,
        },
        200
      )
  )

  const pipelineCheckRoute = createRoute({
    operationId: 'pipeline_check',
    method: 'post',
    path: '/pipeline_check',
    tags: ['Stateless Sync API'],
    summary: 'Check connector connection',
    description:
      'Validates the source/destination config and tests connectivity. Streams NDJSON messages (connection_status, log, trace) tagged with _emitted_by. ' +
      'Pass only=source or only=destination to check a single side.',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: pipelineRequestBody } },
    },
    responses: {
      200: {
        description: 'NDJSON stream of check messages',
        content: { 'application/x-ndjson': { schema: ndjsonRef.CheckOutput } },
      },
      400: errorResponse,
    },
  })
  app.openapi(pipelineCheckRoute, async (c) => {
    const { pipeline, only } = c.req.valid('json')
    const context = { path: '/pipeline_check', ...syncRequestContext(pipeline) }
    return ndjsonResponse(
      logApiStream(
        'Engine API /pipeline_check',
        engine.pipeline_check(pipeline, only ? { only } : undefined),
        context
      )
    )
  })

  const pipelineSetupRoute = createRoute({
    operationId: 'pipeline_setup',
    method: 'post',
    path: '/pipeline_setup',
    tags: ['Stateless Sync API'],
    summary: 'Set up destination schema',
    description:
      'Creates destination tables and applies migrations. Streams NDJSON messages (control, log, trace) tagged with _emitted_by. ' +
      'Pass only=destination to run destination setup alone (e.g. optimistic table creation) or only=source to isolate the source.',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: pipelineRequestBody } },
    },
    responses: {
      200: {
        description: 'NDJSON stream of setup messages',
        content: { 'application/x-ndjson': { schema: ndjsonRef.SetupOutput } },
      },
      400: errorResponse,
    },
  })
  app.openapi(pipelineSetupRoute, async (c) => {
    const { pipeline, only } = c.req.valid('json')
    const context = { path: '/pipeline_setup', ...syncRequestContext(pipeline) }
    return ndjsonResponse(
      logApiStream(
        'Engine API /pipeline_setup',
        engine.pipeline_setup(pipeline, only ? { only } : undefined),
        context
      )
    )
  })

  const pipelineTeardownRoute = createRoute({
    operationId: 'pipeline_teardown',
    method: 'post',
    path: '/pipeline_teardown',
    tags: ['Stateless Sync API'],
    summary: 'Tear down destination schema',
    description:
      'Drops destination tables. Streams NDJSON messages (log, trace) tagged with _emitted_by. ' +
      'Pass only=destination or only=source to run a single side.',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: pipelineRequestBody } },
    },
    responses: {
      200: {
        description: 'NDJSON stream of teardown messages',
        content: { 'application/x-ndjson': { schema: ndjsonRef.TeardownOutput } },
      },
      400: errorResponse,
    },
  })
  app.openapi(pipelineTeardownRoute, async (c) => {
    const { pipeline, only } = c.req.valid('json')
    const context = { path: '/pipeline_teardown', ...syncRequestContext(pipeline) }
    return ndjsonResponse(
      logApiStream(
        'Engine API /pipeline_teardown',
        engine.pipeline_teardown(pipeline, only ? { only } : undefined),
        context
      )
    )
  })

  const sourceDiscoverRoute = createRoute({
    operationId: 'source_discover',
    method: 'post',
    path: '/source_discover',
    tags: ['Stateless Sync API'],
    summary: 'Discover available streams',
    description: 'Streams NDJSON messages (catalog, logs, traces) for the configured source.',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: sourceRequestBody } },
    },
    responses: {
      200: {
        description: 'NDJSON stream of discover messages',
        content: { 'application/x-ndjson': { schema: ndjsonRef.DiscoverOutput } },
      },
      400: errorResponse,
    },
  })
  app.openapi(sourceDiscoverRoute, async (c) => {
    const { source } = c.req.valid('json')
    const context = { path: '/source_discover', sourceName: source.type }
    return ndjsonResponse(
      logApiStream('Engine API /source_discover', engine.source_discover(source), context)
    )
  })

  const pipelineReadRoute = createRoute({
    operationId: 'pipeline_read',
    method: 'post',
    path: '/pipeline_read',
    tags: ['Stateless Sync API'],
    summary: 'Read records from source',
    description: 'Streams NDJSON messages (records, state, catalog).',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: syncRequestBody } },
    },
    responses: {
      200: {
        description: 'NDJSON stream of sync messages',
        content: { 'application/x-ndjson': { schema: ndjsonRef.Message } },
      },
      400: errorResponse,
    },
  })
  app.openapi(pipelineReadRoute, async (c) => {
    const { pipeline, state, time_limit, stdin } = c.req.valid('json')

    const input = stdin
      ? (async function* () {
          for (const m of stdin) yield m
        })()
      : undefined

    const context = { path: '/pipeline_read', ...syncRequestContext(pipeline) }
    const startedAt = Date.now()
    log.info(context, 'Engine API /pipeline_read started')

    const onDisconnect = () =>
      log.warn(
        { elapsed_ms: Date.now() - startedAt, event: 'SYNC_CLIENT_DISCONNECT' },
        'SYNC_CLIENT_DISCONNECT'
      )
    const ac = createConnectionAbort(c, onDisconnect)

    const output = engine.pipeline_read(pipeline, { state, time_limit }, input)
    return ndjsonResponse(logApiStream('Engine API /pipeline_read', output, context, startedAt), {
      signal: ac.signal,
    })
  })

  const pipelineWriteRoute = createRoute({
    operationId: 'pipeline_write',
    method: 'post',
    path: '/pipeline_write',
    tags: ['Stateless Sync API'],
    summary: 'Write records to destination',
    description:
      'Writes messages to the destination. Pass an array of messages in the request body.',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: writeRequestBody } },
    },
    responses: {
      200: {
        description: 'NDJSON stream of write result messages',
        content: { 'application/x-ndjson': { schema: ndjsonRef.DestinationOutput } },
      },
      400: errorResponse,
    },
  })
  app.openapi(pipelineWriteRoute, async (c) => {
    const { pipeline, stdin: messages } = c.req.valid('json')

    const context = { path: '/pipeline_write', ...syncRequestContext(pipeline) }
    const startedAt = Date.now()
    log.info(context, 'Engine API /write started')

    const onDisconnect = () =>
      log.warn(
        { elapsed_ms: Date.now() - startedAt, event: 'SYNC_CLIENT_DISCONNECT' },
        'SYNC_CLIENT_DISCONNECT'
      )
    const ac = createConnectionAbort(c, onDisconnect)

    async function* iter(): AsyncIterable<Message> {
      for (const m of messages) yield m as Message
    }

    return ndjsonResponse(
      logApiStream(
        'Engine API /write',
        engine.pipeline_write(pipeline, iter()),
        context,
        startedAt
      ),
      { signal: ac.signal }
    )
  })

  const pipelineSyncRoute = createRoute({
    operationId: 'pipeline_sync',
    method: 'post',
    path: '/pipeline_sync',
    tags: ['Stateless Sync API'],
    summary: 'Run sync pipeline (read → write)',
    description: 'Reads from the source connector and writes to the destination (backfill mode).',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: syncRequestBody } },
    },
    responses: {
      200: {
        description: 'NDJSON stream of sync messages',
        content: { 'application/x-ndjson': { schema: ndjsonRef.SyncOutput } },
      },
      400: errorResponse,
    },
  })
  app.openapi(pipelineSyncRoute, async (c) => {
    const { pipeline, state, time_limit, soft_time_limit, run_id, stdin } = c.req.valid('json')

    const input = stdin
      ? (async function* () {
          for (const m of stdin) yield m
        })()
      : undefined

    const context = { path: '/pipeline_sync', ...syncRequestContext(pipeline) }
    const startedAt = Date.now()

    const onDisconnect = () =>
      log.warn(
        { elapsed_ms: Date.now() - startedAt, event: 'SYNC_CLIENT_DISCONNECT' },
        'SYNC_CLIENT_DISCONNECT'
      )
    const ac = createConnectionAbort(c, onDisconnect)

    const output = engine.pipeline_sync(
      pipeline,
      { state, time_limit, soft_time_limit, run_id },
      input
    )

    const heartbeat = setInterval(() => {
      log.info({ ...context, elapsed_ms: Date.now() - startedAt }, 'pipeline_sync heartbeat')
    }, 1_000)

    const cleaned = (async function* () {
      try {
        yield* output
      } finally {
        clearInterval(heartbeat)
      }
    })()

    return ndjsonResponse(logApiStream('Engine API /pipeline_sync', cleaned, context, startedAt), {
      signal: ac.signal,
    })
  })

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
              schema: z.object({ items: z.array(ConnectorListItem) }),
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
      operationId: 'meta_sources_get',
      method: 'get',
      path: '/meta/sources/{type}',
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
        return c.json(await engine.meta_sources_get(type), 200)
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
              schema: z.object({ items: z.array(ConnectorListItem) }),
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
      operationId: 'meta_destinations_get',
      method: 'get',
      path: '/meta/destinations/{type}',
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
        return c.json(await engine.meta_destinations_get(type), 200)
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
          'Stripe Sync Engine — stateless, one-shot source/destination sync over HTTP.\nAll sync endpoints accept configuration via a JSON request body.',
      },
      // Register NDJSON message schemas as components (used via raw $ref in routes
      // to avoid zod-openapi generating *Output duplicates for dual-use schemas).
      components: {
        schemas: {
          Message: MessageSchema,
          DiscoverOutput: DiscoverOutputSchema,
          DestinationOutput: DestinationOutputSchema,
          SyncOutput: SyncOutputSchema,
          CheckOutput: CheckOutputSchema,
          SetupOutput: SetupOutputSchema,
          TeardownOutput: TeardownOutputSchema,
        },
      },
    })

    // Patch ControlMessage's source_config/destination_config to reference typed
    // connector config schemas instead of the protocol's untyped Record<string, unknown>.
    patchControlMessageSchema(spec, sourceConfigNames, destConfigNames)

    spec.info.description =
      (spec.info.description ?? '') + '\n\n## Endpoints\n\n' + endpointTable(spec)
    return c.json(spec)
  })

  app.get('/docs', apiReference({ url: '/openapi.json' }))

  // ── Internal utilities ───────────────────────────────────────────────────────
  // NOTE: no HTTP auth on /internal/* — only safe on a trusted private network.

  const internalQueryRoute = createRoute({
    operationId: 'internalQuery',
    method: 'post',
    path: '/internal/query',
    tags: ['Internal'],
    summary: 'Run a SQL query against a Postgres connection',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            connection_string: z.string().optional(),
            url: z.string().optional(),
            sql: z.string(),
          }),
        },
      },
    },
    responses: {
      200: {
        description: 'Query results',
        content: {
          'application/json': {
            schema: z.object({
              rows: z.array(z.record(z.string(), z.unknown())),
              rowCount: z.number().int(),
            }),
          },
        },
      },
      400: errorResponse,
    },
  })
  app.openapi(internalQueryRoute, async (c) => {
    const { connection_string, url, sql } = c.req.valid('json')
    const connStr = connection_string ?? url
    if (!connStr) {
      return c.json({ error: 'connection_string or url is required' }, 400)
    }
    const ssl = sslConfigFromConnectionString(connStr)
    // No query logging — user-provided SQL may contain sensitive data
    const pool = new pg.Pool(
      withPgConnectProxy({
        connectionString: stripSslParams(connStr),
        ssl,
      })
    )
    try {
      const result = await pool.query(sql.trim())
      return c.json({ rows: result.rows ?? [], rowCount: result.rowCount ?? 0 })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Query failed'
      return c.json({ error: message }, 400)
    } finally {
      await pool.end()
    }
  })

  return app
}
