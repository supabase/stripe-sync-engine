import { FastifyInstance } from 'fastify'
import { verifyApiKey } from '../utils/verifyApiKey'
import { SyncBackfillParams } from 'stripe-replit-sync'

export default async function routes(fastify: FastifyInstance) {
  fastify.post('/sync', {
    preHandler: [verifyApiKey],
    handler: async (request, reply) => {
      const { created, object, backfillRelatedEntities } =
        (request.body as {
          created?: SyncBackfillParams['created']
          object?: string
          backfillRelatedEntities?: boolean
        }) ?? {}
      const params = { created, object, backfillRelatedEntities } as SyncBackfillParams
      const result = await fastify.stripeSync.syncBackfill(params)
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

      const result = await fastify.stripeSync.syncSingleEntity(stripeId)

      return reply.send({
        statusCode: 200,
        ts: Date.now(),
        data: result,
      })
    },
  })
}
