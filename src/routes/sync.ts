import { FastifyInstance } from 'fastify'
import { syncProducts, syncPrices, syncSubscriptions } from '../lib/sync'

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(server: FastifyInstance) {
  /**
   * POST /products/sync
   *    Sync products from Stripe
   */
  server.post('/sync', {
    handler: async (request, reply) => {
      const products = await syncProducts()
      const prices = await syncPrices()
      const subscriptions = await syncSubscriptions()
      return reply.send({
        statusCode: 200,
        ts: Date.now(),
        products,
        prices,
        subscriptions,
      })
    },
  })
}
