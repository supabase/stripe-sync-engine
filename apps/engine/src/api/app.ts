import { Hono } from 'hono'
import { z } from 'zod'
import { createDocument } from 'zod-openapi'
import { apiReference } from '@scalar/hono-api-reference'
import { HTTPException } from 'hono/http-exception'
import pg from 'pg'
import type { Message, DestinationOutput, ConnectorResolver, SyncParams } from '../lib/index.js'
import {
  createEngine,
  createEngineFromParams,
  noopStateStore,
  parseNdjsonStream,
  selectStateStore,
  PipelineConfig,
} from '../lib/index.js'
import {
  Message as MessageSchema,
  DestinationOutput as DestinationOutputSchema,
} from '@stripe/sync-protocol'
import { takeStateCheckpoints } from '../lib/pipeline.js'
import { ndjsonResponse } from '@stripe/sync-ts-cli/ndjson'
import { logger } from '../logger.js'
import { createStripeSource, DEFAULT_MAX_RPS } from '@stripe/sync-source-stripe'
import type { RateLimiter } from '@stripe/sync-source-stripe'
import { acquire, createRateLimiterTable, ident } from '@stripe/sync-util-postgres'
import { createHash } from 'node:crypto'

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

/**
 * When the destination is Postgres, create a distributed rate limiter backed
 * by a `_rate_limit_buckets` table so multiple workers share a single bucket.
 * Returns `undefined` for non-Postgres destinations.
 */
async function createPgRateLimiter(
  pipeline: PipelineConfig
): Promise<{ rateLimiter: RateLimiter; close(): Promise<void> } | undefined> {
  if (pipeline.source.name !== 'stripe') return undefined
  if (pipeline.destination.name !== 'postgres') return undefined

  const destConfig = pipeline.destination as Record<string, unknown>
  const connStr = destConfig.connection_string as string | undefined
  if (!connStr) return undefined

  const pool = new pg.Pool({ connectionString: connStr })
  const schema = destConfig.schema as string | undefined
  if (schema) {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`)
  }
  await createRateLimiterTable(pool, schema)

  const srcConfig = pipeline.source as Record<string, unknown>
  const apiKey = srcConfig.api_key as string
  const maxRps = (srcConfig.rate_limit as number | undefined) ?? DEFAULT_MAX_RPS
  const keyHash = createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
  const opts = { key: `stripe:${keyHash}`, max_rps: maxRps, schema }
  const rateLimiter: RateLimiter = async (cost = 1) => acquire(pool, opts, cost)

  return { rateLimiter, close: () => pool.end() }
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
  const app = new Hono()

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

  /** Resolve connectors, optionally wrapping the source with a Postgres-backed rate limiter. */
  async function resolveEngineWithRateLimiter(
    pipeline: PipelineConfig,
    stateStore: Parameters<typeof createEngine>[2],
    state?: Record<string, unknown>
  ) {
    const rl = await createPgRateLimiter(pipeline)

    const sourceName = pipeline.source.name
    const destName = pipeline.destination.name
    const [resolvedSource, destination] = await Promise.all([
      resolver.resolveSource(sourceName),
      resolver.resolveDestination(destName),
    ])
    const source = rl ? createStripeSource({ rateLimiter: rl.rateLimiter }) : resolvedSource
    const engine = createEngine(
      pipeline,
      { source, destination },
      stateStore,
      { sourceName, destinationName: destName },
      state
    )

    return { engine, close: () => rl?.close() }
  }

  // ── Routes ─────────────────────────────────────────────────────

  app.get('/health', (c) => c.json({ ok: true }))

  app.post('/setup', async (c) => {
    const params = parseSyncParams(c)
    const context = { path: '/setup', ...syncRequestContext(params) }
    const startedAt = Date.now()
    logger.info(context, 'Engine API /setup started')
    const engine = await createEngineFromParams(params.pipeline, resolver, noopStateStore())
    try {
      await engine.setup()
      logger.info({ ...context, durationMs: Date.now() - startedAt }, 'Engine API /setup completed')
      return c.body(null, 204)
    } catch (error) {
      logger.error(
        { ...context, durationMs: Date.now() - startedAt, err: error },
        'Engine API /setup failed'
      )
      throw error
    }
  })

  app.post('/teardown', async (c) => {
    const params = parseSyncParams(c)
    const engine = await createEngineFromParams(params.pipeline, resolver, noopStateStore())
    await engine.teardown()
    return c.body(null, 204)
  })

  app.get('/check', async (c) => {
    const params = parseSyncParams(c)
    const engine = await createEngineFromParams(params.pipeline, resolver, noopStateStore())
    const result = await engine.check()
    return c.json(result, 200)
  })

  app.post('/read', async (c) => {
    const params = parseSyncParams(c)
    const inputPresent = hasBody(c)
    const context = { path: '/read', inputPresent, ...syncRequestContext(params) }
    const startedAt = Date.now()
    logger.info(context, 'Engine API /read started')
    const { engine, close } = await resolveEngineWithRateLimiter(
      params.pipeline,
      noopStateStore(),
      params.state
    )

    const input = inputPresent ? parseNdjsonStream(c.req.raw.body!) : undefined
    let output: AsyncIterable<Message> = engine.read(input)
    if (params.stateCheckpointLimit) {
      output = takeStateCheckpoints<Message>(params.stateCheckpointLimit)(output)
    }
    return ndjsonResponse(
      closeAfter(logApiStream('Engine API /read', output, context, startedAt), () => close())
    )
  })

  app.post('/write', async (c) => {
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
    )
  })

  app.post('/sync', async (c) => {
    const params = parseSyncParams(c)
    const stateStore = await selectStateStore(params.pipeline)
    const { engine, close } = await resolveEngineWithRateLimiter(
      params.pipeline,
      stateStore,
      params.state
    )

    const input = hasBody(c) ? parseNdjsonStream(c.req.raw.body!) : undefined
    let output: AsyncIterable<DestinationOutput> = engine.sync(input)
    if (params.stateCheckpointLimit) {
      output = takeStateCheckpoints<DestinationOutput>(params.stateCheckpointLimit)(output)
    }
    return ndjsonResponse(
      closeAfter(output, async () => {
        await stateStore.close?.()
        await close()
      })
    )
  })

  app.get('/connectors', (c) => {
    const sources = Object.fromEntries(
      [...resolver.sources()].map(([name, r]) => [name, { config_schema: r.rawConfigJsonSchema }])
    )
    const destinations = Object.fromEntries(
      [...resolver.destinations()].map(([name, r]) => [
        name,
        { config_schema: r.rawConfigJsonSchema },
      ])
    )
    return c.json({ sources, destinations })
  })

  // ── OpenAPI spec + Swagger UI ───────────────────────────────────

  function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1)
  }

  function connectorSchemaName(name: string, role: 'Source' | 'Destination'): string {
    const pascal = name
      .split(/[-_]/)
      .map((w) => capitalize(w))
      .join('')
    return `${pascal}${role}Config`
  }

  // Shared header param schemas for the OpenAPI spec
  const xPipelineHeader = z
    .string()
    .optional()
    .meta({
      description:
        'JSON-encoded PipelineConfig: { source: { name, ...config }, destination: { name, ...config }, streams }',
      example: JSON.stringify({
        source: { name: 'stripe', api_key: 'sk_test_...' },
        destination: { name: 'postgres', connection_string: 'postgres://localhost/db' },
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

  const errorResponse = {
    description: 'Invalid params',
    content: {
      'application/json': {
        schema: z.object({ error: z.unknown() }),
      },
    },
  }

  const pipelineHeaders = {
    header: z.object({ 'x-pipeline': xPipelineHeader }),
  }

  const allSyncHeaders = {
    header: z.object({
      'x-pipeline': xPipelineHeader,
      'x-state': xStateHeader,
      'x-state-checkpoint-limit': xCheckpointLimitHeader,
    }),
  }

  app.get('/openapi.json', (c) => {
    const spec = createDocument(
      {
        openapi: '3.1.0',
        info: {
          title: 'Stripe Sync Engine',
          version: '1.0.0',
          description:
            'Stripe Sync Engine — stateless, one-shot source/destination sync over HTTP.\nAll sync endpoints accept configuration via the `X-Pipeline` header (JSON-encoded PipelineConfig). Optional cursor state can be provided via `X-State`.',
        },
        paths: {
          '/health': {
            get: {
              operationId: 'health',
              tags: ['Status'],
              summary: 'Health check',
              responses: {
                '200': {
                  description: 'Server is healthy',
                  content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
                },
              },
            },
          },
          '/setup': {
            post: {
              operationId: 'setup',
              tags: ['Stateless Sync API'],
              summary: 'Set up destination schema',
              description:
                'Creates destination tables and applies migrations. Safe to call multiple times.',
              requestParams: pipelineHeaders,
              responses: {
                '204': { description: 'Setup complete' },
                '400': errorResponse,
              },
            },
          },
          '/teardown': {
            post: {
              operationId: 'teardown',
              tags: ['Stateless Sync API'],
              summary: 'Tear down destination schema',
              description: 'Drops destination tables. Irreversible.',
              requestParams: pipelineHeaders,
              responses: {
                '204': { description: 'Teardown complete' },
                '400': errorResponse,
              },
            },
          },
          '/check': {
            get: {
              operationId: 'check',
              tags: ['Stateless Sync API'],
              summary: 'Check connector connection',
              description: 'Validates the source/destination config and tests connectivity.',
              requestParams: pipelineHeaders,
              responses: {
                '200': {
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
                '400': errorResponse,
              },
            },
          },
          '/read': {
            post: {
              operationId: 'read',
              tags: ['Stateless Sync API'],
              summary: 'Read records from source',
              description:
                'Streams NDJSON messages (records, state, catalog). Optional NDJSON body provides catalog/state as input.',
              requestParams: allSyncHeaders,
              responses: {
                '200': {
                  description: 'NDJSON stream of sync messages',
                  content: { 'application/x-ndjson': { schema: MessageSchema } },
                },
                '400': errorResponse,
              },
            },
          },
          '/write': {
            post: {
              operationId: 'write',
              tags: ['Stateless Sync API'],
              summary: 'Write records to destination',
              description:
                'Reads NDJSON messages from the request body and writes them to the destination. Pipe /read output as input.',
              requestParams: pipelineHeaders,
              requestBody: {
                required: true,
                content: { 'application/x-ndjson': { schema: MessageSchema } },
              },
              responses: {
                '200': {
                  description: 'NDJSON stream of write result messages',
                  content: { 'application/x-ndjson': { schema: DestinationOutputSchema } },
                },
                '400': errorResponse,
              },
            },
          },
          '/sync': {
            post: {
              operationId: 'sync',
              tags: ['Stateless Sync API'],
              summary: 'Run sync pipeline (read → write)',
              description:
                'Without a request body, reads from the source connector and writes to the destination (backfill mode). ' +
                'With an NDJSON request body, uses the provided messages as input instead of reading from the source (push mode — e.g. piped webhook events).',
              requestParams: allSyncHeaders,
              responses: {
                '200': {
                  description: 'NDJSON stream of sync messages',
                  content: { 'application/x-ndjson': { schema: DestinationOutputSchema } },
                },
                '400': errorResponse,
              },
            },
          },
          '/connectors': {
            get: {
              operationId: 'listConnectors',
              tags: ['Connectors'],
              summary: 'List available connectors and their config schemas',
              responses: {
                '200': {
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
            },
          },
        },
      },
      { allowEmptySchema: { unknown: true }, outputIdSuffix: '' }
    )

    // Inject typed connector config schemas into OpenAPI components
    const doc = spec as any
    if (!doc.components) doc.components = {}
    if (!doc.components.schemas) doc.components.schemas = {}

    for (const [name, r] of resolver.sources()) {
      const schema = JSON.parse(JSON.stringify(r.rawConfigJsonSchema))
      schema.properties = { name: { type: 'string', enum: [name] }, ...(schema.properties ?? {}) }
      schema.required = ['name', ...(schema.required ?? [])]
      doc.components.schemas[connectorSchemaName(name, 'Source')] = schema
    }

    for (const [name, r] of resolver.destinations()) {
      const schema = JSON.parse(JSON.stringify(r.rawConfigJsonSchema))
      schema.properties = { name: { type: 'string', enum: [name] }, ...(schema.properties ?? {}) }
      schema.required = ['name', ...(schema.required ?? [])]
      doc.components.schemas[connectorSchemaName(name, 'Destination')] = schema
    }

    const sourceNames = [...resolver.sources().keys()]
    if (sourceNames.length > 0) {
      doc.components.schemas['SourceConfig'] = {
        discriminator: { propertyName: 'name' },
        oneOf: sourceNames.map((n) => ({
          $ref: `#/components/schemas/${connectorSchemaName(n, 'Source')}`,
        })),
      }
    }

    const destNames = [...resolver.destinations().keys()]
    if (destNames.length > 0) {
      doc.components.schemas['DestinationConfig'] = {
        discriminator: { propertyName: 'name' },
        oneOf: destNames.map((n) => ({
          $ref: `#/components/schemas/${connectorSchemaName(n, 'Destination')}`,
        })),
      }
    }

    doc.components.schemas['PipelineConfig'] = {
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

    // Annotate JSON-encoded headers with contentMediaType / contentSchema (OAS 3.1)
    for (const [, methods] of Object.entries(doc.paths ?? {})) {
      for (const [, op] of Object.entries(methods as Record<string, any>)) {
        for (const param of op?.parameters ?? []) {
          if (param.in !== 'header') continue
          if (param.name === 'x-pipeline') {
            param.schema = {
              type: 'string',
              contentMediaType: 'application/json',
              contentSchema: { $ref: '#/components/schemas/PipelineConfig' },
            }
          } else if (param.name === 'x-state') {
            param.schema = {
              type: 'string',
              contentMediaType: 'application/json',
              contentSchema: {
                type: 'object',
                additionalProperties: true,
                description: 'Per-stream cursor state keyed by stream name',
              },
            }
          }
        }
      }
    }

    spec.info.description += '\n\n## Endpoints\n\n' + endpointTable(spec)
    return c.json(spec)
  })

  app.get('/docs', apiReference({ url: '/openapi.json' }))

  return app
}
