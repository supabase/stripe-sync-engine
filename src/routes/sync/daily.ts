import { FastifyInstance } from 'fastify'
import { syncBackfill, SyncBackfillParams } from '../../lib/sync'

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(fastify: FastifyInstance) {
  fastify.post('/daily', {
    handler: async (request, reply) => {
      const { object } = request.query as { object?: string }
      const currentTimeInSeconds = Math.floor(Date.now() / 1000)
      const dayAgoTimeInSeconds = currentTimeInSeconds - 60 * 60 * 24
      const params = {
        gteCreated: dayAgoTimeInSeconds,
        object: object ?? 'all',
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
