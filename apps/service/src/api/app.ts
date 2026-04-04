import { OpenAPIHono, createRoute } from '@stripe/sync-hono-zod-openapi'
import { z } from 'zod'
import { apiReference } from '@scalar/hono-api-reference'
import type { WorkflowClient } from '@temporalio/client'
import type { ConnectorResolver } from '@stripe/sync-engine'
import { endpointTable, addDiscriminators } from '@stripe/sync-engine/api/openapi-utils'
import { createSchemas } from '../lib/createSchemas.js'
import type { Pipeline } from '../lib/createSchemas.js'
import type { PipelineStore } from '../lib/stores.js'
import type { WorkflowStatus } from '../temporal/workflows/_shared.js'

const DEFAULT_PIPELINE_WORKFLOW = 'pipelineWorkflow'
const GOOGLE_SHEETS_PIPELINE_WORKFLOW = 'googleSheetPipelineWorkflow'

function workflowTypeForPipeline(pipeline: Pipeline): string {
  return pipeline.destination.type === 'google-sheets'
    ? GOOGLE_SHEETS_PIPELINE_WORKFLOW
    : DEFAULT_PIPELINE_WORKFLOW
}

// MARK: - Helpers

let _idCounter = Date.now()
function genId(prefix: string): string {
  return `${prefix}_${(_idCounter++).toString(36)}`
}

async function queryStatus(
  temporal: WorkflowClient,
  id: string
): Promise<WorkflowStatus | undefined> {
  try {
    return await temporal.getHandle(id).query<WorkflowStatus>('status')
  } catch {
    return undefined
  }
}

// MARK: - Response schemas (static — don't depend on connector set)

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
  temporal: { client: WorkflowClient; taskQueue: string }
  resolver: ConnectorResolver
  pipelines: PipelineStore
}

export function createApp(options: AppOptions) {
  const { client: temporal, taskQueue } = options.temporal
  const { pipelines } = options
  const {
    Pipeline: PipelineSchema,
    CreatePipeline: CreatePipelineSchema,
    UpdatePipeline: UpdatePipelineSchema,
  } = createSchemas(options.resolver)

  const PipelineWithStatusSchema = PipelineSchema.extend({
    status: z
      .object({
        phase: z.string().describe('Current workflow phase (e.g. "backfill", "live", "idle").'),
        paused: z.boolean().describe('Whether the pipeline is currently paused.'),
        iteration: z.number().describe('Number of times this workflow has continued-as-new.'),
      })
      .optional()
      .describe('Live workflow status. Absent if no workflow is running for this pipeline.'),
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
    id: z.string().meta({ example: 'pipe_abc123' }),
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
      operationId: 'pipelines.list',
      method: 'get',
      path: '/pipelines',
      tags: ['Pipelines'],
      summary: 'List pipelines',
      responses: {
        200: {
          content: {
            'application/json': { schema: ListResponse(PipelineWithStatusSchema) },
          },
          description: 'List of pipelines',
        },
      },
    }),
    async (c) => {
      const stored = await pipelines.list()
      const result = await Promise.all(
        stored.map(async (pipeline) => {
          const status = await queryStatus(temporal, pipeline.id)
          return status ? { ...pipeline, status } : pipeline
        })
      )
      return c.json({ data: result, has_more: false } as any, 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'pipelines.create',
      method: 'post',
      path: '/pipelines',
      tags: ['Pipelines'],
      summary: 'Create pipeline',
      requestBody: {
        content: { 'application/json': { schema: CreatePipelineSchema } },
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
      const pipeline = { id, ...(body as Record<string, unknown>) } as Pipeline
      await pipelines.set(id, pipeline)
      await temporal.start(workflowTypeForPipeline(pipeline), {
        workflowId: id,
        taskQueue,
        args: [id],
      })
      return c.json(pipeline as any, 201)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'pipelines.get',
      method: 'get',
      path: '/pipelines/{id}',
      tags: ['Pipelines'],
      summary: 'Retrieve pipeline',
      requestParams: { path: PipelineIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: PipelineWithStatusSchema } },
          description: 'Retrieved pipeline with status',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      let pipeline: Pipeline
      try {
        pipeline = await pipelines.get(id)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
      const status = await queryStatus(temporal, id)
      return c.json(status ? { ...pipeline, status } : (pipeline as any), 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'pipelines.update',
      method: 'patch',
      path: '/pipelines/{id}',
      tags: ['Pipelines'],
      summary: 'Update pipeline',
      requestParams: { path: PipelineIdParam },
      requestBody: {
        content: { 'application/json': { schema: UpdatePipelineSchema } },
      },
      responses: {
        200: {
          content: { 'application/json': { schema: PipelineWithStatusSchema } },
          description: 'Updated pipeline',
        },
        400: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Bad request',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const patch = c.req.valid('json') as Partial<Pipeline>

      let current: Pipeline
      try {
        current = await pipelines.get(id)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }

      // Validate google-sheets constraints
      const next = {
        ...current,
        ...(patch.source ? { source: patch.source } : {}),
        ...(patch.destination ? { destination: patch.destination } : {}),
        ...(patch.streams !== undefined ? { streams: patch.streams } : {}),
      } as Pipeline
      if (workflowTypeForPipeline(current) !== workflowTypeForPipeline(next)) {
        return c.json(
          {
            error:
              'Changing destination.type between google-sheets and non-google-sheets requires recreating the pipeline',
          },
          400
        )
      }
      if (
        current.destination.type === 'google-sheets' &&
        current.destination.spreadsheet_id !== next.destination.spreadsheet_id
      ) {
        return c.json(
          {
            error:
              'Changing the target spreadsheet for a google-sheets pipeline requires recreating the pipeline',
          },
          400
        )
      }

      // Write to store
      const updated = await pipelines.update(id, {
        ...(patch.source ? { source: patch.source } : {}),
        ...(patch.destination ? { destination: patch.destination } : {}),
        ...(patch.streams !== undefined ? { streams: patch.streams } : {}),
      })

      // Best-effort: notify the workflow that config changed
      try {
        await temporal.getHandle(id).signal('update', {})
      } catch {
        // Workflow may not be running — config is persisted, that's fine
      }

      const status = await queryStatus(temporal, id)
      return c.json(status ? { ...updated, status } : (updated as any), 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'pipelines.pause',
      method: 'post',
      path: '/pipelines/{id}/pause',
      tags: ['Pipelines'],
      summary: 'Pause pipeline',
      requestParams: { path: PipelineIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: PipelineWithStatusSchema } },
          description: 'Paused pipeline',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      let pipeline: Pipeline
      try {
        pipeline = await pipelines.get(id)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
      try {
        await temporal.getHandle(id).signal('update', { paused: true })
        await new Promise((r) => setTimeout(r, 200))
      } catch {
        return c.json({ error: `Pipeline ${id} workflow not found` }, 404)
      }
      const status = await queryStatus(temporal, id)
      return c.json(status ? { ...pipeline, status } : (pipeline as any), 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'pipelines.resume',
      method: 'post',
      path: '/pipelines/{id}/resume',
      tags: ['Pipelines'],
      summary: 'Resume pipeline',
      requestParams: { path: PipelineIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: PipelineWithStatusSchema } },
          description: 'Resumed pipeline',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      let pipeline: Pipeline
      try {
        pipeline = await pipelines.get(id)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
      try {
        await temporal.getHandle(id).signal('update', { paused: false })
        await new Promise((r) => setTimeout(r, 200))
      } catch {
        return c.json({ error: `Pipeline ${id} workflow not found` }, 404)
      }
      const status = await queryStatus(temporal, id)
      return c.json(status ? { ...pipeline, status } : (pipeline as any), 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'pipelines.delete',
      method: 'delete',
      path: '/pipelines/{id}',
      tags: ['Pipelines'],
      summary: 'Delete pipeline',
      requestParams: { path: PipelineIdParam },
      responses: {
        200: {
          content: { 'application/json': { schema: DeleteResponseSchema } },
          description: 'Deleted pipeline',
        },
        404: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Not found',
        },
        500: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Teardown or deletion failed',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')

      try {
        await pipelines.get(id)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }

      // Signal the workflow to run teardown, if it's running
      try {
        const handle = temporal.getHandle(id)
        const desc = await handle.describe()
        if (desc.status.name === 'RUNNING') {
          await handle.signal('delete')
          await handle.result()
        }
      } catch {
        // Workflow not found or already finished — proceed to delete from store
      }

      await pipelines.delete(id)
      return c.json({ id, deleted: true as const }, 200)
    }
  )

  // MARK: - Webhook ingress

  const WebhookParam = z.object({
    pipeline_id: z.string().meta({ example: 'pipe_abc123' }),
  })

  app.openapi(
    createRoute({
      operationId: 'webhooks.push',
      method: 'post',
      path: '/webhooks/{pipeline_id}',
      tags: ['Webhooks'],
      summary: 'Ingest a Stripe webhook event',
      description:
        "Receives a raw Stripe webhook event, verifies its signature using the pipeline's webhook secret, and enqueues it for processing by the active pipeline.",
      requestParams: { path: WebhookParam },
      responses: {
        200: {
          content: { 'text/plain': { schema: z.literal('ok') } },
          description: 'Event accepted',
        },
      },
    }),
    async (c) => {
      const { pipeline_id } = c.req.valid('param')
      const body = await c.req.text()
      const headers = Object.fromEntries(c.req.raw.headers.entries())
      temporal
        .getHandle(pipeline_id)
        .signal('stripe_event', { body, headers })
        .catch(() => {})
      return c.text('ok', 200)
    }
  )

  // MARK: - OpenAPI spec + Swagger UI

  app.get('/openapi.json', (c) => {
    const spec = app.getOpenAPI31Document({
      info: {
        title: 'Stripe Sync Service',
        version: '1.0.0',
        description: 'Stripe Sync Service — manage pipelines and webhook ingress.',
      },
    })
    spec.info.description += '\n\n## Endpoints\n\n' + endpointTable(spec)
    // @hono/zod-openapi doesn't emit discriminator for z.discriminatedUnion —
    // walk the spec and inject it wherever oneOf variants share a `type` enum.
    addDiscriminators(spec)
    return c.json(spec)
  })

  app.get('/docs', apiReference({ url: '/openapi.json' }))

  return app
}
