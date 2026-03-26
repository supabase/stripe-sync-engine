import { homedir } from 'node:os'
import { join } from 'node:path'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { apiReference } from '@scalar/hono-api-reference'
import type { ConnectorResolver, Message } from '@stripe/sync-engine'
import { createConnectorResolver, parseNdjsonStream } from '@stripe/sync-engine'
import { ndjsonResponse } from '@stripe/sync-engine'
import {
  Pipeline as PipelineSchema,
  CreatePipeline as CreatePipelineSchema,
  UpdatePipeline as UpdatePipelineSchema,
} from '../lib/schemas.js'
import type { Pipeline } from '../lib/schemas.js'
import { SyncService } from '../lib/service.js'
import type { TemporalOptions } from '../temporal/bridge.js'
import { filePipelineStore, fileStateStore, fileLogSink } from '../lib/stores-fs.js'
import { mountWebhookRoutes } from './webhook-app.js'

// MARK: - Helpers

function endpointTable(spec: { paths?: Record<string, unknown> }) {
  const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])
  const rows = Object.entries(spec.paths ?? {}).flatMap(([path, methods]) =>
    Object.entries(methods as Record<string, { summary?: string }>)
      .filter(([m]) => HTTP_METHODS.has(m))
      .map(([method, op]) => `| ${method.toUpperCase()} | ${path} | ${op.summary ?? ''} |`)
  )
  return ['| Method | Path | Summary |', '|--------|------|---------|', ...rows].join('\n')
}

let _idCounter = Date.now()
function genId(prefix: string): string {
  return `${prefix}_${(_idCounter++).toString(36)}`
}

// MARK: - Response schemas

const ConnectorCheckSchema = z.object({
  status: z.enum(['succeeded', 'failed']),
  message: z.string().optional(),
})

const CheckResultSchema = z.object({
  source: ConnectorCheckSchema,
  destination: ConnectorCheckSchema,
})

const NdjsonSchema = z.string().openapi({
  description: 'Newline-delimited JSON sync messages, one per line',
  example: '{"type":"record","stream":"products","data":{"id":"prod_123","name":"Widget"}}\n',
})

const DeleteResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
})

const ErrorSchema = z.object({ error: z.unknown() })

function ListResponse<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    has_more: z.boolean(),
  })
}

// MARK: - App factory

export interface AppOptions {
  dataDir?: string
  /** Pre-built connector resolver (for tests with mocks). */
  connectors?: ConnectorResolver
  /** When set, sync lifecycle is managed by Temporal instead of running in-process. */
  temporal?: TemporalOptions
}

export function createApp(options?: AppOptions) {
  const dataDir = options?.dataDir || process.env.DATA_DIR || join(homedir(), '.stripe-sync')
  const connectors = options?.connectors ?? createConnectorResolver({})

  const pipelines = filePipelineStore(`${dataDir}/pipelines`)
  const states = fileStateStore(`${dataDir}/state`)
  const logs = fileLogSink(`${dataDir}/logs.ndjson`)

  const service = new SyncService({
    pipelines,
    states,
    logs,
    connectors,
    temporal: options?.temporal,
  })

  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues }, 400)
      }
    },
  })

  // ── Path param schemas ──────────────────────────────────────────

  const PipelineIdParam = z.object({
    id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'pipe_abc123' }),
  })

  // ── Health ──────────────────────────────────────────────────────

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
            'application/json': { schema: z.object({ ok: z.literal(true) }) },
          },
          description: 'Server is healthy',
        },
      },
    }),
    (c) => c.json({ ok: true as const }, 200)
  )

  // MARK: - Pipelines

  app.openapi(
    createRoute({
      operationId: 'listPipelines',
      method: 'get',
      path: '/pipelines',
      tags: ['Pipelines'],
      summary: 'List pipelines',
      responses: {
        200: {
          content: {
            'application/json': { schema: ListResponse(PipelineSchema) },
          },
          description: 'List of pipelines',
        },
      },
    }),
    async (c) => {
      const list = await pipelines.list()
      return c.json({ data: list, has_more: false } as any, 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'createPipeline',
      method: 'post',
      path: '/pipelines',
      tags: ['Pipelines'],
      summary: 'Create pipeline',
      request: {
        body: {
          content: { 'application/json': { schema: CreatePipelineSchema } },
        },
      },
      responses: {
        201: {
          content: { 'application/json': { schema: PipelineSchema } },
          description: 'Created pipeline',
        },
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Invalid input',
        },
      },
    }),
    async (c) => {
      const body = c.req.valid('json')
      const id = genId('pipe')
      const stored = { id, ...(body as Record<string, unknown>) } as Pipeline
      await pipelines.set(id, stored)
      await service.temporal?.start(id)
      return c.json(stored as any, 201)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'getPipeline',
      method: 'get',
      path: '/pipelines/{id}',
      tags: ['Pipelines'],
      summary: 'Retrieve pipeline',
      request: { params: PipelineIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: PipelineSchema } },
          description: 'Retrieved pipeline',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      try {
        const pipeline = await pipelines.get(id)
        return c.json(pipeline as any, 200)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
    }
  )

  app.openapi(
    createRoute({
      operationId: 'updatePipeline',
      method: 'patch',
      path: '/pipelines/{id}',
      tags: ['Pipelines'],
      summary: 'Update pipeline',
      request: {
        params: PipelineIdParam,
        body: {
          content: { 'application/json': { schema: UpdatePipelineSchema } },
        },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: PipelineSchema } },
          description: 'Updated pipeline',
        },
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Invalid input',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const patch = c.req.valid('json')
      try {
        const existing = await pipelines.get(id)
        const updated = {
          ...existing,
          ...(patch as Record<string, unknown>),
          id,
        } as Pipeline
        await pipelines.set(id, updated)
        // No need to signal the workflow — activities re-read config from the service on each call
        return c.json(updated as any, 200)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
    }
  )

  app.openapi(
    createRoute({
      operationId: 'deletePipeline',
      method: 'delete',
      path: '/pipelines/{id}',
      tags: ['Pipelines'],
      summary: 'Delete pipeline',
      request: { params: PipelineIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: DeleteResponseSchema } },
          description: 'Deleted pipeline',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      try {
        await pipelines.get(id)
        await service.temporal?.stop(id)
        await pipelines.delete(id)
        await states.clear(id)
        return c.json({ id, deleted: true as const }, 200)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
    }
  )

  // MARK: - Pipeline engine operations

  app.openapi(
    createRoute({
      operationId: 'setupPipeline',
      method: 'post',
      path: '/pipelines/{id}/setup',
      tags: ['Pipeline Operations'],
      summary: 'Set up destination schema for a pipeline',
      description:
        'Creates destination tables and applies migrations. Safe to call multiple times.',
      request: { params: PipelineIdParam },
      responses: {
        204: { description: 'Setup complete' },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Pipeline not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      await service.setup(id)
      return c.body(null, 204) as any
    }
  )

  app.openapi(
    createRoute({
      operationId: 'teardownPipeline',
      method: 'post',
      path: '/pipelines/{id}/teardown',
      tags: ['Pipeline Operations'],
      summary: 'Tear down destination schema for a pipeline',
      description: 'Drops destination tables. Irreversible.',
      request: { params: PipelineIdParam },
      responses: {
        204: { description: 'Teardown complete' },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Pipeline not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      await service.teardown(id)
      return c.body(null, 204) as any
    }
  )

  app.openapi(
    createRoute({
      operationId: 'checkPipeline',
      method: 'get',
      path: '/pipelines/{id}/check',
      tags: ['Pipeline Operations'],
      summary: 'Check connector connection for a pipeline',
      description: 'Validates the source/destination config and tests connectivity.',
      request: { params: PipelineIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: CheckResultSchema } },
          description: 'Connection check result',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Pipeline not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const result = await service.check(id)
      return c.json(result, 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'readPipeline',
      method: 'post',
      path: '/pipelines/{id}/read',
      tags: ['Pipeline Operations'],
      summary: 'Read records from the pipeline source',
      description:
        'Streams NDJSON messages (records, state, catalog). Optional NDJSON body provides input.',
      request: { params: PipelineIdParam },
      responses: {
        200: {
          content: { 'application/x-ndjson': { schema: NdjsonSchema } },
          description: 'NDJSON stream of sync messages',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Pipeline not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.raw.body
      const input = body ? parseNdjsonStream(body) : undefined
      return ndjsonResponse(service.read(id, input)) as any
    }
  )

  app.openapi(
    createRoute({
      operationId: 'writePipeline',
      method: 'post',
      path: '/pipelines/{id}/write',
      tags: ['Pipeline Operations'],
      summary: 'Write records to the pipeline destination',
      description:
        'Reads NDJSON messages from the request body and writes them to the destination.',
      request: {
        params: PipelineIdParam,
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
          description: 'Missing request body',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Pipeline not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.raw.body
      if (!body) {
        return c.json({ error: 'Request body required for /write' }, 400)
      }
      const messages = parseNdjsonStream<Message>(body)
      return ndjsonResponse(service.write(id, messages)) as any
    }
  )

  app.openapi(
    createRoute({
      operationId: 'syncPipeline',
      method: 'post',
      path: '/pipelines/{id}/sync',
      tags: ['Pipeline Operations'],
      summary: 'Run pipeline (read → write)',
      description:
        'Without a request body, reads from the source connector and writes to the destination (backfill mode). ' +
        'With an NDJSON request body, uses the provided messages as input instead of reading from the source (push mode — e.g. piped webhook events).',
      request: { params: PipelineIdParam },
      responses: {
        200: {
          content: { 'application/x-ndjson': { schema: NdjsonSchema } },
          description: 'NDJSON stream of sync messages',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Pipeline not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.raw.body
      const input = body && c.req.header('content-type') ? parseNdjsonStream(body) : undefined
      return ndjsonResponse(service.run(id, input)) as any
    }
  )

  // MARK: - Temporal-only operations (pause / resume)

  app.openapi(
    createRoute({
      operationId: 'pausePipeline',
      method: 'post',
      path: '/pipelines/{id}/pause',
      tags: ['Pipeline Operations'],
      summary: 'Pause a running pipeline (Temporal mode only)',
      description:
        'Signals the Temporal workflow to pause. The pipeline will stop processing after the current batch completes. Requires --temporal-address.',
      request: { params: PipelineIdParam },
      responses: {
        204: { description: 'Pause signal sent' },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Pipeline not found',
        },
        409: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Pause requires Temporal mode',
        },
      },
    }),
    async (c) => {
      if (!service.temporal) {
        return c.json({ error: 'Pause requires Temporal mode (--temporal-address)' }, 409)
      }
      const { id } = c.req.valid('param')
      try {
        await pipelines.get(id)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
      await service.temporal.pause(id)
      return c.body(null, 204) as any
    }
  )

  app.openapi(
    createRoute({
      operationId: 'resumePipeline',
      method: 'post',
      path: '/pipelines/{id}/resume',
      tags: ['Pipeline Operations'],
      summary: 'Resume a paused pipeline (Temporal mode only)',
      description: 'Signals the Temporal workflow to resume. Requires --temporal-address.',
      request: { params: PipelineIdParam },
      responses: {
        204: { description: 'Resume signal sent' },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Pipeline not found',
        },
        409: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Resume requires Temporal mode',
        },
      },
    }),
    async (c) => {
      if (!service.temporal) {
        return c.json({ error: 'Resume requires Temporal mode (--temporal-address)' }, 409)
      }
      const { id } = c.req.valid('param')
      try {
        await pipelines.get(id)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
      await service.temporal.resume(id)
      return c.body(null, 204) as any
    }
  )

  // MARK: - Webhook ingress (mounted from webhook-app.ts)

  mountWebhookRoutes(app, (id, e) => service.push_event(id, e))

  // MARK: - OpenAPI spec + Swagger UI

  app.get('/openapi.json', (c) => {
    const spec = app.getOpenAPIDocument({
      openapi: '3.0.0',
      info: {
        title: 'Stripe Sync Service',
        version: '1.0.0',
        description: 'Stripe Sync Service — manage pipelines and webhook ingress.',
      },
    })
    spec.info.description += '\n\n## Endpoints\n\n' + endpointTable(spec)
    return c.json(spec)
  })

  app.get('/docs', apiReference({ url: '/openapi.json' }))

  return app
}
