import { FastifyInstance } from 'fastify'
import { verifyApiKey } from '../utils/verifyApiKey'
import { SyncParams } from 'stripe-experiment-sync'

export default async function routes(fastify: FastifyInstance) {
  fastify.post('/sync', {
    preHandler: [verifyApiKey],
    handler: async (request, reply) => {
      const { created, object, backfillRelatedEntities } =
        (request.body as {
          created?: SyncParams['created']
          object?: string
          backfillRelatedEntities?: boolean
        }) ?? {}
      const params = { created, object, backfillRelatedEntities } as SyncParams
      const result = await fastify.stripeSync.processUntilDone(params)
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
