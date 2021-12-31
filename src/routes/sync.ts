import { FastifyInstance } from 'fastify'
import { syncProducts } from '../lib/sync'

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(server: FastifyInstance) {
  /**
   * POST /products/sync
   *    Sync products from Stripe
   */
  server.get('/sync', {
    handler: async (request, reply) => {
      const products = await syncProducts()
      return reply.send({
        statusCode: 200,
        ts: Date.now(),
        products,
      })
    },
  })
}
