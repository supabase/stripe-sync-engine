import os from 'node:os'
import {
  OpenAPIHono,
  createRoute,
  isApplicationJsonContentType,
} from '@stripe/sync-hono-zod-openapi'
import { z } from 'zod'
import { apiReference } from '@scalar/hono-api-reference'
import { HTTPException } from 'hono/http-exception'
import pg from 'pg'
import type { Message, ConnectorResolver } from '../lib/index.js'
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
  SourceInputMessage: { $ref: '#/components/schemas/SourceInputMessage' },
}
import { ndjsonResponse } from '@stripe/sync-ts-cli/ndjson'
import { logger } from '../logger.js'
import {
  sslConfigFromConnectionString,
  stripSslParams,
  withPgConnectProxy,
} from '@stripe/sync-util-postgres'
import { syncRequestContext, logApiStream, createConnectionAbort, verboseInput } from './helpers.js'
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
    logger.error({ err }, 'Unhandled error')
    if (engineRequestId) c.header(ENGINE_REQUEST_ID_HEADER, engineRequestId)
    return c.json({ error: 'Internal server error' }, 500)
  })

  app.use('*', async (c, next) => {
    const engineRequestId = crypto.randomUUID()
    await runWithEngineRequestContext({ engineRequestId }, async () => {
      const start = Date.now()
      logger.info({ method: c.req.method, path: c.req.path }, 'request start')
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
      logger[level](
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

  /** Node.js 24 sets c.req.raw.body to a non-null empty ReadableStream even for bodyless POSTs. */
  function hasBody(c: { req: { header: (name: string) => string | undefined } }): boolean {
    const cl = c.req.header('Content-Length')
    if (cl !== undefined) return Number(cl) > 0
    if (c.req.header('Transfer-Encoding')) return true
    return false
  }

  function isJsonBody(c: { req: { header: (name: string) => string | undefined } }): boolean {
    return isApplicationJsonContentType(c.req.header('content-type'))
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
    .pipe(SyncState.catch(emptySyncState()))
    .optional()
    .meta({
      description:
        'JSON-encoded SyncState ({ source, destination, sync_run }). Falls back to empty state if invalid.',
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

  const pipelineHeaders = z.object({ 'x-pipeline': xPipelineHeader.optional() })
  const sourceHeaders = z.object({ 'x-source': xSourceHeader.optional() })
  const allSyncHeaders = z.object({
    'x-pipeline': xPipelineHeader.optional(),
    'x-state': xStateHeader,
  })

  // ── JSON body schemas (native objects, no string-parse transform) ────
  // Registered in route definitions for both OpenAPI docs and runtime validation.
  // OpenAPIHono's content-type-aware validator skips JSON body parsing for
  // non-JSON requests, so these strict schemas coexist safely with NDJSON routes.

  const pipelineBody = z.object({
    pipeline: TypedPipelineConfig,
  })

  const syncBody = z.object({
    pipeline: TypedPipelineConfig,
    state: SyncState.optional(),
    body: z.array(z.unknown()).optional(),
  })

  const writeBody = z.object({
    pipeline: TypedPipelineConfig,
    body: z.array(z.unknown()),
  })

  const sourceBody = z.object({
    source: z.object({ type: z.string() }).catchall(z.unknown()),
  })

  function requireHeaderValue<T>(value: T | undefined, message: string): T {
    if (value === undefined) throw new HTTPException(400, { message })
    return value
  }

  // Hono's `req.valid()` typing is route-specific and doesn't compose cleanly across
  // helpers, so we keep the helper signatures loose and return strongly typed values.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getPipeline(c: any): z.infer<typeof TypedPipelineConfig> {
    if (isJsonBody(c)) return c.req.valid('json').pipeline
    return requireHeaderValue(c.req.valid('header')['x-pipeline'], 'x-pipeline header is required')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getPipelineAndState(c: any): {
    pipeline: z.infer<typeof TypedPipelineConfig>
    state: z.infer<typeof SyncState> | undefined
  } {
    if (isJsonBody(c)) {
      const { pipeline, state } = c.req.valid('json')
      return { pipeline, state }
    }

    return {
      pipeline: requireHeaderValue(
        c.req.valid('header')['x-pipeline'],
        'x-pipeline header is required'
      ),
      state: c.req.valid('header')['x-state'],
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getSource(c: any): z.infer<typeof sourceBody>['source'] {
    if (isJsonBody(c)) return c.req.valid('json').source
    return requireHeaderValue(c.req.valid('header')['x-source'], 'x-source header is required')
  }

  const syncQueryParams = z.object({
    state_limit: z.coerce.number().int().positive().optional().meta({
      description: 'Stop streaming after N state messages.',
      example: '100',
    }),
    time_limit: z.coerce.number().positive().optional().meta({
      description: 'Stop streaming after N seconds.',
      example: '10',
    }),
    sync_run_id: z.string().optional().meta({
      description: 'Optional sync run identifier used to track bounded sync progress.',
      example: 'run_demo',
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
      'Validates the source/destination config and tests connectivity. Streams NDJSON messages (connection_status, log, trace) tagged with _emitted_by.',
    requestParams: { header: pipelineHeaders },
    requestBody: {
      required: false,
      content: { 'application/json': { schema: pipelineBody } },
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
    const pipeline = getPipeline(c)
    const context = { path: '/pipeline_check', ...syncRequestContext(pipeline) }
    return ndjsonResponse(
      logApiStream('Engine API /pipeline_check', engine.pipeline_check(pipeline), context)
    )
  })

  const onlyQueryParam = z.object({
    only: z.enum(['source', 'destination']).optional().meta({
      description:
        'Run only the source or destination side. Useful for optimistic destination setup (e.g. creating tables early in a UI) or isolating a connector when debugging.',
      example: 'destination',
    }),
  })

  const pipelineSetupRoute = createRoute({
    operationId: 'pipeline_setup',
    method: 'post',
    path: '/pipeline_setup',
    tags: ['Stateless Sync API'],
    summary: 'Set up destination schema',
    description:
      'Creates destination tables and applies migrations. Streams NDJSON messages (control, log, trace) tagged with _emitted_by. ' +
      'Pass ?only=destination to run destination setup alone (e.g. optimistic table creation) or ?only=source to isolate the source.',
    requestParams: { header: pipelineHeaders, query: onlyQueryParam },
    requestBody: {
      required: false,
      content: { 'application/json': { schema: pipelineBody } },
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
    const pipeline = getPipeline(c)
    const only = c.req.valid('query').only
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
      'Pass ?only=destination or ?only=source to run a single side.',
    requestParams: { header: pipelineHeaders, query: onlyQueryParam },
    requestBody: {
      required: false,
      content: { 'application/json': { schema: pipelineBody } },
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
    const pipeline = getPipeline(c)
    const only = c.req.valid('query').only
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
    requestParams: { header: sourceHeaders },
    requestBody: {
      required: false,
      content: { 'application/json': { schema: sourceBody } },
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
    const source = getSource(c)
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
      'Streams NDJSON messages (records, state, catalog). Optional NDJSON body provides live events as input. ' +
      'Alternatively, send Content-Type: application/json with {pipeline, state?, body?} to pass config in the body.',
    requestParams: { header: allSyncHeaders, query: syncQueryParams },
    requestBody: {
      required: false,
      content: {
        'application/x-ndjson': {
          schema: SourceInputMessage ? ndjsonRef.SourceInputMessage : ndjsonRef.Message,
        },
        'application/json': { schema: syncBody },
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
    const { state_limit, time_limit } = c.req.valid('query')

    const { pipeline, state } = getPipelineAndState(c)
    let input: AsyncIterable<unknown> | undefined

    if (isJsonBody(c)) {
      const json = c.req.valid('json')
      const bodyMessages = json.body
      if (bodyMessages?.length) {
        if (SourceInputMessage) {
          input = (async function* () {
            for (const msg of bodyMessages) {
              const parsed = SourceInputMessage.parse(msg)
              yield (parsed as { source_input: unknown }).source_input
            }
          })()
        } else {
          input = (async function* () {
            for (const msg of bodyMessages) {
              yield msg
            }
          })()
        }
      }
    } else if (hasBody(c)) {
      if (SourceInputMessage) {
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

    const inputPresent = !!input
    const context = { path: '/pipeline_read', inputPresent, ...syncRequestContext(pipeline) }
    const startedAt = Date.now()
    logger.info(context, 'Engine API /pipeline_read started')

    const onDisconnect = () =>
      logger.warn(
        { elapsed_ms: Date.now() - startedAt, event: 'SYNC_CLIENT_DISCONNECT' },
        'SYNC_CLIENT_DISCONNECT'
      )
    const ac = createConnectionAbort(c, onDisconnect)

    const output = engine.pipeline_read(pipeline, { state, state_limit, time_limit }, input)
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
      'Reads NDJSON messages from the request body and writes them to the destination. Pipe /read output as input. ' +
      'Alternatively, send Content-Type: application/json with {pipeline, body: [...messages]}.',
    requestParams: { header: pipelineHeaders },
    requestBody: {
      required: true,
      content: {
        'application/x-ndjson': { schema: ndjsonRef.Message },
        'application/json': { schema: writeBody },
      },
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
    const pipeline = getPipeline(c)
    let messages: AsyncIterable<Message>

    if (isJsonBody(c)) {
      const json = c.req.valid('json')
      messages = (async function* () {
        for (const msg of json.body) {
          yield msg
        }
      })() as AsyncIterable<Message>
    } else {
      if (hasBody(c)) {
        messages = verboseInput(
          'pipeline_write',
          parseNdjsonStream<Message>(c.req.raw.body!)
        ) as AsyncIterable<Message>
      } else {
        const context = { path: '/pipeline_write', ...syncRequestContext(pipeline) }
        logger.error(context, 'Engine API /write missing request body')
        return c.json({ error: 'Request body required for /write' }, 400)
      }
    }

    const context = { path: '/pipeline_write', ...syncRequestContext(pipeline) }
    const startedAt = Date.now()
    logger.info(context, 'Engine API /write started')

    const onDisconnect = () =>
      logger.warn(
        { elapsed_ms: Date.now() - startedAt, event: 'SYNC_CLIENT_DISCONNECT' },
        'SYNC_CLIENT_DISCONNECT'
      )
    const ac = createConnectionAbort(c, onDisconnect)

    return ndjsonResponse(
      logApiStream(
        'Engine API /write',
        engine.pipeline_write(pipeline, messages),
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
    description:
      'Without a request body, reads from the source connector and writes to the destination (backfill mode). ' +
      'With an NDJSON request body, uses the provided messages as input instead of reading from the source (push mode — e.g. piped webhook events). ' +
      'Alternatively, send Content-Type: application/json with {pipeline, state?, body?} to pass config in the body.',
    requestParams: { header: allSyncHeaders, query: syncQueryParams },
    requestBody: {
      required: false,
      content: {
        'application/x-ndjson': {
          schema: SourceInputMessage ? ndjsonRef.SourceInputMessage : ndjsonRef.Message,
        },
        'application/json': { schema: syncBody },
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
    const { state_limit, time_limit, sync_run_id } = c.req.valid('query')

    const { pipeline, state } = getPipelineAndState(c)
    let input: AsyncIterable<unknown> | undefined

    if (isJsonBody(c)) {
      const json = c.req.valid('json')
      const bodyMessages = json.body
      if (bodyMessages?.length) {
        input = (async function* () {
          for (const msg of bodyMessages) {
            yield msg
          }
        })()
      }
    } else if (hasBody(c)) {
      input = verboseInput('pipeline_sync', parseNdjsonStream(c.req.raw.body!))
    }

    const context = { path: '/pipeline_sync', ...syncRequestContext(pipeline) }
    const startedAt = Date.now()

    const onDisconnect = () =>
      logger.warn(
        { elapsed_ms: Date.now() - startedAt, event: 'SYNC_CLIENT_DISCONNECT' },
        'SYNC_CLIENT_DISCONNECT'
      )
    const ac = createConnectionAbort(c, onDisconnect)

    const output = engine.pipeline_sync(
      pipeline,
      { state, state_limit, time_limit, sync_run_id },
      input
    )
    return ndjsonResponse(logApiStream('Engine API /pipeline_sync', output, context, startedAt), {
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
    // No query logging — user-provided SQL may contain sensitive data
    const pool = new pg.Pool(
      withPgConnectProxy({
        connectionString: stripSslParams(connection_string),
        ssl,
      })
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
