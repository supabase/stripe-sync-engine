import { FastifyInstance } from 'fastify'
import { syncBackfill, SyncBackfillParams } from '../lib/sync'
import { verifyApiKey } from '../utils/verifyApiKey'

import Stripe from 'stripe'

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(fastify: FastifyInstance) {
  fastify.post('/sync', {
    preHandler: [verifyApiKey],
    handler: async (request, reply) => {
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
