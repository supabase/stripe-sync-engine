import os from 'node:os'
import { OpenAPIHono, createRoute } from '@stripe/sync-hono-zod-openapi'
import { z } from 'zod'
import { apiReference } from '@scalar/hono-api-reference'
import type { WorkflowClient } from '@temporalio/client'
import type { ConnectorResolver } from '@stripe/sync-engine'
import { endpointTable } from '@stripe/sync-engine/api/openapi-utils'
import { collectFirst, drain, type Message } from '@stripe/sync-protocol'
import { createSchemas, PipelineId } from '../lib/createSchemas.js'
import type { Pipeline } from '../lib/createSchemas.js'
import type { PipelineStore } from '../lib/stores.js'
import { verifyWebhookSignature, WebhookSignatureError } from '@stripe/sync-source-stripe'

// MARK: - Helpers

let _idCounter = Date.now()
function genId(prefix: string): string {
  return `${prefix}_${(_idCounter++).toString(36)}`
}

// MARK: - Response schemas (static — don't depend on connector set)

const ErrorSchema = z.object({ error: z.unknown() })

function ListResponse<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    has_more: z.boolean(),
  })
}

function configPayload(envelope: {
  type: string
  [key: string]: unknown
}): Record<string, unknown> {
  return (envelope[envelope.type] as Record<string, unknown>) ?? {}
}

async function parseConnectorConfig(
  connector: { spec(): AsyncIterable<{ type: string; [k: string]: unknown }> },
  rawConfig: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const specMsg = await collectFirst(connector.spec(), 'spec')
  return z.fromJSONSchema(specMsg.spec.config).parse(rawConfig) as Record<string, unknown>
}

async function checkPipelineConnectors(
  resolver: ConnectorResolver,
  pipeline: Pick<Pipeline, 'source' | 'destination'>
) {
  const [sourceConnector, destinationConnector] = await Promise.all([
    resolver.resolveSource(pipeline.source.type),
    resolver.resolveDestination(pipeline.destination.type),
  ])

  const [sourceConfig, destinationConfig] = await Promise.all([
    parseConnectorConfig(sourceConnector, configPayload(pipeline.source)),
    parseConnectorConfig(destinationConnector, configPayload(pipeline.destination)),
  ])

  await Promise.all([
    drain(sourceConnector.check({ config: sourceConfig })).catch((err) => {
      throw new Error(
        `Source check failed (${pipeline.source.type}): ${String(err instanceof Error ? err.message : err)}`
      )
    }),
    drain(destinationConnector.check({ config: destinationConfig })).catch((err) => {
      throw new Error(
        `Destination check failed (${pipeline.destination.type}): ${String(err instanceof Error ? err.message : err)}`
      )
    }),
  ])
}

// MARK: - App factory

export interface AppOptions {
  temporal?: { client: WorkflowClient; taskQueue: string }
  resolver: ConnectorResolver
  pipelineStore: PipelineStore
}

export function createApp(options: AppOptions) {
  const temporal = options.temporal?.client
  const taskQueue = options.temporal?.taskQueue
  const { pipelineStore, resolver } = options
  const {
    Pipeline: PipelineSchema,
    CreatePipeline: CreatePipelineSchema,
    UpdatePipeline: UpdatePipelineSchema,
  } = createSchemas(resolver)

  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues }, 400)
      }
    },
  })

  // ── Path param schemas ──────────────────────────────────────────

  const PipelineIdParam = z.object({
    id: PipelineId.meta({ example: 'pipe_abc123' }),
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
            'application/json': {
              schema: z.object({ ok: z.literal(true), hostname: z.string() }),
            },
          },
          description: 'Server is healthy',
        },
      },
    }),
    (c) => c.json({ ok: true as const, hostname: os.hostname() }, 200)
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
            'application/json': { schema: ListResponse(PipelineSchema) },
          },
          description: 'List of pipelines',
        },
      },
    }),
    async (c) => {
      const stored = await pipelineStore.list()
      const result = stored.filter((p) => p.desired_status !== 'deleted')
      return c.json({ data: result, has_more: false }, 200)
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
        409: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Pipeline id already exists',
        },
      },
    }),
    async (c) => {
      const body = c.req.valid('json')
      try {
        await checkPipelineConnectors(resolver, body as Pick<Pipeline, 'source' | 'destination'>)
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
      }
      const id = body.id ?? genId('pipe')
      try {
        await pipelineStore.get(id)
        return c.json({ error: `Pipeline ${id} already exists` }, 409)
      } catch {
        // expected when the id is new
      }
      const pipeline: Pipeline = {
        id,
        ...(body as Record<string, unknown>),
        desired_status: 'active',
        status: 'setup',
      } as Pipeline
      await pipelineStore.set(id, pipeline)
      if (temporal && taskQueue) {
        await temporal.start('pipelineWorkflow', {
          workflowId: id,
          taskQueue,
          args: [id],
        })
      }
      return c.json(pipeline, 201)
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
          content: { 'application/json': { schema: PipelineSchema } },
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
        pipeline = await pipelineStore.get(id)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
      if (pipeline.desired_status === 'deleted') {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }
      return c.json(pipeline, 200)
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
          content: { 'application/json': { schema: PipelineSchema } },
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
        409: {
          content: { 'application/json': { schema: ErrorSchema } },
          description: 'Invalid status transition',
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const patch = c.req.valid('json') as Partial<Pipeline>

      let current: Pipeline
      try {
        current = await pipelineStore.get(id)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }

      // Validate desired_status transition
      if (patch.desired_status && patch.desired_status !== current.desired_status) {
        if (current.desired_status === 'deleted') {
          return c.json({ error: 'Pipeline is deleted — create a new pipeline instead' }, 409)
        }
      }

      // Build store patch
      const storePatch: Partial<Omit<Pipeline, 'id'>> = {}
      if (patch.source) storePatch.source = patch.source
      if (patch.destination) storePatch.destination = patch.destination
      if (patch.streams !== undefined) storePatch.streams = patch.streams
      if (patch.desired_status) storePatch.desired_status = patch.desired_status

      const updated = await pipelineStore.update(id, storePatch)

      // Best-effort: notify the workflow of pause/resume
      if (temporal && (patch.desired_status === 'paused' || patch.desired_status === 'active')) {
        try {
          await temporal.getHandle(id).signal('paused', patch.desired_status === 'paused')
        } catch {
          // Workflow may not be running — store is updated, that's fine
        }
      }

      return c.json(updated, 200)
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
          content: {
            'application/json': {
              schema: z.object({ id: z.string(), deleted: z.literal(true) }),
            },
          },
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
        await pipelineStore.get(id)
      } catch {
        return c.json({ error: `Pipeline ${id} not found` }, 404)
      }

      if (!temporal) {
        await pipelineStore.delete(id)
        return c.json({ id, deleted: true as const }, 200)
      }

      // Soft-delete in store (workflow will hard-delete after teardown)
      await pipelineStore.update(id, { desired_status: 'deleted' })

      // Cancel the workflow — triggers teardown in non-cancellable scope
      try {
        await temporal.getHandle(id).cancel()
      } catch {
        // Workflow may not be running — hard-delete from store directly
        await pipelineStore.delete(id)
      }

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

      // Look up pipeline to get the webhook secret
      const pipeline = await pipelineStore.get(pipeline_id)
      if (!pipeline) {
        return c.text('pipeline not found', 404)
      }

      if (pipeline.source.type !== 'stripe') {
        return c.text('webhook ingress is only supported for stripe sources', 400)
      }

      const sourceConfig = pipeline.source[pipeline.source.type] as
        | { webhook_secret?: string }
        | undefined
      const webhookSecret = sourceConfig?.webhook_secret
      if (!webhookSecret) {
        return c.text('pipeline has no webhook_secret configured', 400)
      }

      // Verify webhook signature
      const body = await c.req.text()
      const signature = c.req.header('stripe-signature') ?? ''
      try {
        verifyWebhookSignature(body, signature, webhookSecret)
      } catch (err) {
        if (err instanceof WebhookSignatureError) {
          return c.text('webhook signature verification failed', 401)
        }
        throw err
      }

      // Forward verified event to the pipeline workflow
      if (!temporal) {
        return c.text('temporal is not configured', 503)
      }

      temporal
        .getHandle(pipeline_id)
        .signal('stripe_event', { body, headers: Object.fromEntries(c.req.raw.headers.entries()) })
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
    return c.json(spec)
  })

  app.get('/docs', apiReference({ url: '/openapi.json' }))

  return app
}
