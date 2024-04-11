import { FastifyInstance } from 'fastify'
import { getConfig } from '../utils/config'

const config = getConfig()

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(fastify: FastifyInstance) {
  fastify.post('/webhooks', {
    handler: async (request, reply) => {
      const sig = request.headers['stripe-signature'] as string
      const body: { raw: Buffer } = request.body as { raw: Buffer }

      const error = fastify.stripeSyncEngine.constructEvent(
        body.raw,
        sig,
        config.STRIPE_WEBHOOK_SECRET
      )
      if (error) {
        return reply.code(400).send({ error: error.message })
      }

      return reply.send({ received: true })
    },
  })
}
