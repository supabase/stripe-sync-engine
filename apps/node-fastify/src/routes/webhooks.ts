import { FastifyInstance } from 'fastify'

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(fastify: FastifyInstance) {
  fastify.post('/webhooks', {
    handler: async (request, reply) => {
      const sig = request.headers['stripe-signature'] as string
      const body: { raw: Buffer } = request.body as { raw: Buffer }

      const error = fastify.stripeSyncEngine.handleWebhookEvent(body.raw, sig)
      if (error) {
        return reply.code(400).send({ error: error?.message })
      }

      return reply.send({ received: true })
    },
  })
}
