import { FastifyInstance } from 'fastify'
import { syncBackfill, SyncBackfillParams } from 'stripe-sync-engine-lib'
import { verifyApiKey } from '../../utils/verifyApiKey'

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(fastify: FastifyInstance) {
  fastify.post('/monthly', {
    preHandler: [verifyApiKey],
    handler: async (request, reply) => {
      const { object, backfillRelatedEntities } =
        (request.body as { object?: string; backfillRelatedEntities?: boolean }) ?? {}
      const currentTimeInSeconds = Math.floor(Date.now() / 1000)
      const monthAgoTimeInSeconds = currentTimeInSeconds - 60 * 60 * 24 * 30
      const params = {
        created: { gte: monthAgoTimeInSeconds },
        object: object ?? 'all',
        backfillRelatedEntities,
      } as SyncBackfillParams

      const result = await syncBackfill(params)
      return reply.send({
        statusCode: 200,
        ts: Date.now(),
        ...result,
      })
    },
  })
}
