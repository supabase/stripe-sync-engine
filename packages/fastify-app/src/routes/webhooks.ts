import { FastifyInstance } from 'fastify'
import { type WebhookRequestBody, webhookBodySchema, withStripeSync } from '../internalApi'

export default async function routes(fastify: FastifyInstance) {
  fastify.post<{ Body: WebhookRequestBody }>('/webhook', {
    schema: {
      body: webhookBodySchema,
    },
    handler: async (request, reply) => {
      await withStripeSync(request.body, async (stripeSync) => {
        await stripeSync.webhook.processEvent(request.body.event)
      })

      return reply.send({
        ok: true,
        merchantId: request.body.merchantId,
        eventId: request.body.event.id,
        eventType: request.body.event.type,
      })
    },
  })
}
