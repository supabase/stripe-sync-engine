import { FastifyInstance } from 'fastify'
import { verifyApiKey } from '../../utils/verifyApiKey'
import { SyncParams } from 'stripe-experiment-sync'

export default async function routes(fastify: FastifyInstance) {
  fastify.post('/daily', {
    preHandler: [verifyApiKey],
    handler: async (request, reply) => {
      const { object, backfillRelatedEntities } =
        (request.body as { object?: string; backfillRelatedEntities?: boolean }) ?? {}
      const currentTimeInSeconds = Math.floor(Date.now() / 1000)
      const dayAgoTimeInSeconds = currentTimeInSeconds - 60 * 60 * 24
      const params = {
        created: { gte: dayAgoTimeInSeconds },
        object: object ?? 'all',
        backfillRelatedEntities,
      } as SyncParams

      await fastify.stripeSync.processUntilDone(params)

      return reply.send({
        statusCode: 200,
        ts: Date.now(),
      })
    },
  })
}
