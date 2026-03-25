import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'

export interface WebhookAppOptions {
  /** Called for each incoming webhook event. Fire-and-forget. */
  push_event: (credentialId: string, event: unknown) => void
}

/**
 * Standalone webhook ingress app — POST /webhooks/{credential_id}.
 *
 * Deliberately thin: no credential management, no sync CRUD. Just receives a
 * raw Stripe event and hands it off to `push_event`, which in Temporal mode
 * signals the matching workflow(s) via TemporalBridge.
 *
 * Used in two ways:
 *   1. Mounted inside the main service app for single-process dev.
 *   2. As a standalone server via `sync-service webhook` for production
 *      deployments where webhook ingress runs on its own port/host.
 */
export function createWebhookApp({ push_event }: WebhookAppOptions) {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues }, 400)
      }
    },
  })

  const WebhookParam = z.object({
    credential_id: z.string().openapi({
      param: { name: 'credential_id', in: 'path' },
      example: 'cred_abc123',
    }),
  })

  app.openapi(
    createRoute({
      operationId: 'pushWebhook',
      method: 'post',
      path: '/webhooks/{credential_id}',
      tags: ['Webhooks'],
      summary: 'Ingest a Stripe webhook event',
      description:
        "Receives a raw Stripe webhook event, verifies its signature using the credential's webhook secret, and enqueues it for processing by the active sync.",
      request: { params: WebhookParam },
      responses: {
        200: {
          content: { 'text/plain': { schema: z.literal('ok') } },
          description: 'Event accepted',
        },
      },
    }),
    async (c) => {
      const { credential_id } = c.req.valid('param')
      const body = await c.req.text()
      const headers = Object.fromEntries(c.req.raw.headers.entries())
      push_event(credential_id, { body, headers })
      return c.text('ok', 200)
    }
  )

  return app
}
