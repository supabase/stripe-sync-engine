import { FastifyInstance } from 'fastify'
import { syncBackfill, SyncBackfillParams, syncSingleEntity } from '../lib/sync'
import { verifyApiKey } from '../utils/verifyApiKey'

import Stripe from 'stripe'

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(fastify: FastifyInstance) {
  fastify.post('/sync', {
    preHandler: [verifyApiKey],
    handler: async (request, reply) => {
      const { created, object, backfillRelatedEntities } =
        (request.body as {
          created?: Stripe.RangeQueryParam
          object?: string
          backfillRelatedEntities?: boolean
        }) ?? {}
      const params = { created, object, backfillRelatedEntities } as SyncBackfillParams
      const result = await syncBackfill(params)
      return reply.send({
        statusCode: 200,
        ts: Date.now(),
        ...result,
      })
    },
  })

  fastify.post<{
    Params: {
      stripeId: string
    }
  }>('/sync/single/:stripeId', {
    preHandler: [verifyApiKey],
    schema: {
      params: {
        type: 'object',
        properties: {
          stripeId: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { stripeId } = request.params

      const result = await syncSingleEntity(stripeId)

      return reply.send({
        statusCode: 200,
        ts: Date.now(),
        data: result,
      })
    },
  })
}
