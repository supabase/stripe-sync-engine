import { OpenAPIHono, createRoute } from '@stripe/sync-hono-zod-openapi'
import { z } from 'zod'
import { apiReference } from '@scalar/hono-api-reference'
import { HTTPException } from 'hono/http-exception'
import pg from 'pg'
import type { Message, ConnectorResolver, TraceMessage } from '../lib/index.js'
import {
  createEngine,
  createConnectorSchemas,
  parseNdjsonStream,
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
  SourceState,
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
  SourceInputMessage: { $ref: '#/components/schemas/SourceInputMessage' },
}
import { ndjsonResponse } from '@stripe/sync-ts-cli/ndjson'
import { logger } from '../logger.js'
import {
  sslConfigFromConnectionString,
  stripSslParams,
  withPgConnectProxy,
  withQueryLogging,
} from '@stripe/sync-util-postgres'

// ── Helpers ─────────────────────────────────────────────────────

function syncRequestContext(pipeline: {
  source: { type: string }
  destination: { type: string }
  streams?: Array<{ name: string }>
}) {
  return {
    sourceName: pipeline.source.type,
    destinationName: pipeline.destination.type,
    configuredStreamCount: pipeline.streams?.length ?? 0,
    configuredStreams: pipeline.streams?.map((stream) => stream.name) ?? [],
  }
}

function traceError(err: unknown): TraceMessage {
  const message = err instanceof Error ? err.message : String(err)
  const stack_trace = err instanceof Error ? err.stack : undefined
  return {
    type: 'trace',
    trace: {
      trace_type: 'error',
      error: {
        failure_type: 'system_error',
        message,
        ...(stack_trace ? { stack_trace } : {}),
      },
    },
  }
}

async function* logApiStream<T>(
  label: string,
  iter: AsyncIterable<T>,
  context: Record<string, unknown>,
  startedAt = Date.now()
): AsyncIterable<T | TraceMessage> {
  let itemCount = 0
  try {
    for await (const item of iter) {
      itemCount++
      if (dangerouslyVerbose) logger.debug({ ...context, item }, `${label} output`)
      yield item
    }
    logger.info({ ...context, itemCount, durationMs: Date.now() - startedAt }, `${label} completed`)
  } catch (error) {
    logger.error(
      { ...context, itemCount, durationMs: Date.now() - startedAt, err: error },
      `${label} failed`
    )
    yield traceError(error)
  }
}

const dangerouslyVerbose = process.env.DANGEROUSLY_VERBOSE_LOGGING === 'true'

async function* verboseInput(label: string, iter: AsyncIterable<unknown>): AsyncIterable<unknown> {
  for await (const msg of iter) {
    if (dangerouslyVerbose) logger.debug({ msg }, `${label} input`)
    yield msg
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

  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID()
    const start = Date.now()
    if (dangerouslyVerbose) {
      const headers: Record<string, unknown> = {}
      c.req.raw.headers.forEach((value, key) => {
        try {
          headers[key] = JSON.parse(value)
        } catch {
          headers[key] = value
        }
      })
      logger.debug(
        { requestId, method: c.req.method, path: c.req.path, headers },
        'request headers'
      )
    }
    logger.info({ requestId, method: c.req.method, path: c.req.path }, 'request start')
    if (dangerouslyVerbose) {
      const curlParts = [`curl -X ${c.req.method} '${c.req.url}'`]
      c.req.raw.headers.forEach((value, key) => {
        curlParts.push(`  -H '${key}: ${value}'`)
      })
      if (hasBody(c)) {
        const cl = c.req.header('Content-Length')
        if (cl && Number(cl) < 100_000) {
          try {
            const body = await c.req.raw.clone().text()
            curlParts.push(`  -d '${body.replace(/'/g, "'\\''")}'`)
          } catch {
            /* skip */
          }
        } else {
          curlParts.push('  --data-binary @-')
        }
      }
      logger.debug(curlParts.join(' \\\n'))
    }
    await next()
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
    logger[level](
      {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Date.now() - start,
        error,
      },
      'request end'
    )
  })

  /** Node.js 24 sets c.req.raw.body to a non-null empty ReadableStream even for bodyless POSTs. */
  function hasBody(c: { req: { header: (name: string) => string | undefined } }): boolean {
    const cl = c.req.header('Content-Length')
    if (cl !== undefined) return Number(cl) > 0
    if (c.req.header('Transfer-Encoding')) return true
    return false
  }

  // ── Typed header schemas (transform + pipe for runtime validation,
  //    .meta({ param: { content } }) for OAS content encoding) ────

  const {
    PipelineConfig: TypedPipelineConfig,
    SourceInputMessage,
    sourceConfigNames,
    destConfigNames,
  } = createConnectorSchemas(resolver)

  const jsonParse = (s: string, ctx: z.RefinementCtx) => {
    try {
      return JSON.parse(s)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid JSON' })
      return z.NEVER
    }
  }

  const xPipelineHeader = z
    .string()
    .transform(jsonParse)
    .pipe(TypedPipelineConfig)
    .meta({
      description: 'JSON-encoded PipelineConfig',
      param: { content: { 'application/json': {} } },
    })

  const xStateHeader = z
    .string()
    .transform(jsonParse)
    .transform((obj: Record<string, unknown>) =>
      // Accept both new format { streams, global } and old flat format { stream_name: data }.
      'streams' in obj && 'global' in obj ? obj : { streams: obj, global: {} }
    )
    .pipe(SourceState)
    .optional()
    .meta({
      description: 'JSON-encoded SourceState ({ streams, global }) or legacy flat per-stream state',
      param: { content: { 'application/json': {} } },
    })

  const xSourceHeader = z
    .string()
    .transform(jsonParse)
    .pipe(z.object({ type: z.string() }).catchall(z.unknown()))
    .meta({
      description: 'JSON-encoded source config ({ type, ...config })',
      param: { content: { 'application/json': {} } },
    })

  const pipelineHeaders = z.object({ 'x-pipeline': xPipelineHeader })
  const sourceHeaders = z.object({ 'x-source': xSourceHeader })
  const allSyncHeaders = z.object({
    'x-pipeline': xPipelineHeader,
    'x-source-state': xStateHeader,
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
          content: {
            'application/json': {
              schema: z.object({
                ok: z.literal(true),
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
      'Validates the source/destination config and tests connectivity. Streams NDJSON messages (connection_status, log, trace) tagged with _emitted_by.',
    requestParams: { header: pipelineHeaders },
    responses: {
      200: {
        description: 'NDJSON stream of check messages',
        content: { 'application/x-ndjson': { schema: ndjsonRef.CheckOutput } },
      },
      400: errorResponse,
    },
  })
  app.openapi(pipelineCheckRoute, (c) => {
    const pipeline = c.req.valid('header')['x-pipeline']
    const context = { path: '/pipeline_check', ...syncRequestContext(pipeline) }
    return ndjsonResponse(
      logApiStream('Engine API /pipeline_check', engine.pipeline_check(pipeline), context)
    )
  })

  const pipelineSetupRoute = createRoute({
    operationId: 'pipeline_setup',
    method: 'post',
    path: '/pipeline_setup',
    tags: ['Stateless Sync API'],
    summary: 'Set up destination schema',
    description:
      'Creates destination tables and applies migrations. Streams NDJSON messages (control, log, trace) tagged with _emitted_by.',
    requestParams: { header: pipelineHeaders },
    responses: {
      200: {
        description: 'NDJSON stream of setup messages',
        content: { 'application/x-ndjson': { schema: ndjsonRef.SetupOutput } },
      },
      400: errorResponse,
    },
  })
  app.openapi(pipelineSetupRoute, (c) => {
    const pipeline = c.req.valid('header')['x-pipeline']
    const context = { path: '/pipeline_setup', ...syncRequestContext(pipeline) }
    return ndjsonResponse(
      logApiStream('Engine API /pipeline_setup', engine.pipeline_setup(pipeline), context)
    )
  })

  const pipelineTeardownRoute = createRoute({
    operationId: 'pipeline_teardown',
    method: 'post',
    path: '/pipeline_teardown',
    tags: ['Stateless Sync API'],
    summary: 'Tear down destination schema',
    description:
      'Drops destination tables. Streams NDJSON messages (log, trace) tagged with _emitted_by.',
    requestParams: { header: pipelineHeaders },
    responses: {
      200: {
        description: 'NDJSON stream of teardown messages',
        content: { 'application/x-ndjson': { schema: ndjsonRef.TeardownOutput } },
      },
      400: errorResponse,
    },
  })
  app.openapi(pipelineTeardownRoute, (c) => {
    const pipeline = c.req.valid('header')['x-pipeline']
    const context = { path: '/pipeline_teardown', ...syncRequestContext(pipeline) }
    return ndjsonResponse(
      logApiStream('Engine API /pipeline_teardown', engine.pipeline_teardown(pipeline), context)
    )
  })

  const sourceDiscoverRoute = createRoute({
    operationId: 'source_discover',
    method: 'post',
    path: '/source_discover',
    tags: ['Stateless Sync API'],
    summary: 'Discover available streams',
    description: 'Streams NDJSON messages (catalog, logs, traces) for the configured source.',
    requestParams: { header: sourceHeaders },
    responses: {
      200: {
        description: 'NDJSON stream of discover messages',
        content: { 'application/x-ndjson': { schema: ndjsonRef.DiscoverOutput } },
      },
      400: errorResponse,
    },
  })
  app.openapi(sourceDiscoverRoute, (c) => {
    const source = c.req.valid('header')['x-source']
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
    description:
      'Streams NDJSON messages (records, state, catalog). Optional NDJSON body provides live events as input.',
    requestParams: { header: allSyncHeaders, query: syncQueryParams },
    requestBody: {
      required: false,
      content: {
        'application/x-ndjson': {
          schema: SourceInputMessage ? ndjsonRef.SourceInputMessage : ndjsonRef.Message,
        },
      },
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
    const pipeline = c.req.valid('header')['x-pipeline']
    const state = c.req.valid('header')['x-source-state']
    const { state_limit, time_limit } = c.req.valid('query')
    const inputPresent = hasBody(c)
    const context = { path: '/pipeline_read', inputPresent, ...syncRequestContext(pipeline) }
    const startedAt = Date.now()
    logger.info(context, 'Engine API /pipeline_read started')

    let input: AsyncIterable<unknown> | undefined
    if (inputPresent) {
      if (SourceInputMessage) {
        // Validate each NDJSON line against the SourceInputMessage envelope,
        // then unwrap the source_input payload for source.read().
        input = (async function* () {
          for await (const msg of verboseInput(
            'pipeline_read',
            parseNdjsonStream(c.req.raw.body!)
          )) {
            const parsed = SourceInputMessage.parse(msg)
            yield (parsed as { source_input: unknown }).source_input
          }
        })()
      } else {
        input = verboseInput('pipeline_read', parseNdjsonStream(c.req.raw.body!))
      }
    }
    const output = engine.pipeline_read(pipeline, { state, state_limit, time_limit }, input)
    return ndjsonResponse(logApiStream('Engine API /pipeline_read', output, context, startedAt))
  })

  const pipelineWriteRoute = createRoute({
    operationId: 'pipeline_write',
    method: 'post',
    path: '/pipeline_write',
    tags: ['Stateless Sync API'],
    summary: 'Write records to destination',
    description:
      'Reads NDJSON messages from the request body and writes them to the destination. Pipe /read output as input.',
    requestParams: { header: pipelineHeaders },
    requestBody: {
      required: true,
      content: { 'application/x-ndjson': { schema: ndjsonRef.Message } },
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
    const pipeline = c.req.valid('header')['x-pipeline']
    const context = { path: '/pipeline_write', ...syncRequestContext(pipeline) }
    if (!hasBody(c)) {
      logger.error(context, 'Engine API /write missing request body')
      return c.json({ error: 'Request body required for /write' }, 400)
    }
    const startedAt = Date.now()
    logger.info(context, 'Engine API /write started')
    const messages = verboseInput(
      'pipeline_write',
      parseNdjsonStream<Message>(c.req.raw.body!)
    ) as AsyncIterable<Message>
    return ndjsonResponse(
      logApiStream(
        'Engine API /write',
        engine.pipeline_write(pipeline, messages),
        context,
        startedAt
      )
    )
  })

  const pipelineSyncRoute = createRoute({
    operationId: 'pipeline_sync',
    method: 'post',
    path: '/pipeline_sync',
    tags: ['Stateless Sync API'],
    summary: 'Run sync pipeline (read → write)',
    description:
      'Without a request body, reads from the source connector and writes to the destination (backfill mode). ' +
      'With an NDJSON request body, uses the provided messages as input instead of reading from the source (push mode — e.g. piped webhook events).',
    requestParams: { header: allSyncHeaders, query: syncQueryParams },
    requestBody: {
      required: false,
      content: {
        'application/x-ndjson': {
          schema: SourceInputMessage ? ndjsonRef.SourceInputMessage : ndjsonRef.Message,
        },
      },
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
    const pipeline = c.req.valid('header')['x-pipeline']
    const state = c.req.valid('header')['x-source-state']
    const { state_limit, time_limit } = c.req.valid('query')
    const input = hasBody(c)
      ? verboseInput('pipeline_sync', parseNdjsonStream(c.req.raw.body!))
      : undefined
    const output = engine.pipeline_sync(pipeline, { state, state_limit, time_limit }, input)
    return ndjsonResponse(output)
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
          'Stripe Sync Engine — stateless, one-shot source/destination sync over HTTP.\nAll sync endpoints accept configuration via the `X-Pipeline` header (JSON-encoded PipelineConfig). Optional cursor state can be provided via `X-State`.',
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
          ...(SourceInputMessage ? { SourceInputMessage } : {}),
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
    method: 'post',
    path: '/internal/query',
    tags: ['Internal'],
    hide: true,
    summary: 'Run a SQL query against a Postgres connection',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            connection_string: z.string(),
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
              rowCount: z.number().nullable(),
            }),
          },
        },
      },
      400: errorResponse,
    },
  })
  app.openapi(internalQueryRoute, async (c) => {
    const { connection_string, sql } = c.req.valid('json')
    const ssl = sslConfigFromConnectionString(connection_string)
    const pool = withQueryLogging(
      new pg.Pool(
        withPgConnectProxy({
          connectionString: stripSslParams(connection_string),
          ssl,
        })
      )
    )
    try {
      const result = await pool.query(sql.trim())
      return c.json({ rows: result.rows, rowCount: result.rowCount })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Query failed'
      return c.json({ error: message }, 400)
    } finally {
      await pool.end()
    }
  })

  return app
}
