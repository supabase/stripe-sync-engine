import { FastifyInstance } from 'fastify'
import { syncBackfill, SyncBackfillParams } from '../lib/sync'
import { getConfig } from '../utils/config'
import Stripe from 'stripe'

const config = getConfig()

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(fastify: FastifyInstance) {
  fastify.post('/sync', {
    handler: async (request, reply) => {
      if (!request.headers || !request.headers.authorization) {
        return reply.code(401).send('Unauthorized')
      }
      const { authorization } = request.headers
      if (authorization !== config.API_KEY) {
        return reply.code(401).send('Unauthorized')
      }

      const { created, object } =
        (request.body as {
          created?: Stripe.RangeQueryParam
          object?: string
        }) ?? {}
      const params = { created, object } as SyncBackfillParams
      const result = await syncBackfill(params)
      return reply.send({
        statusCode: 200,
        ts: Date.now(),
        ...result,
      })
    },
  })
}
