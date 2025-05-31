import { FastifyInstance } from 'fastify'
import { logger } from '../logger'

export default async function routes(fastify: FastifyInstance) {
  fastify.post('/webhooks', {
    handler: async (request, reply) => {
      const body: { raw: Buffer } = request.body as { raw: Buffer }
      const signature = request.headers['stripe-signature'] as string

      try {
        await fastify.stripeSync.processWebhook(body.raw, signature)
      } catch (error) {
        logger.error('Webhook processing error:', error)
        return reply.code(400).send(`Webhook Error: ${error.message}`)
      }
      return reply.send({ received: true })
    },
  })
}
