import { FastifyInstance } from 'fastify'
import { syncBackfill, SyncBackfillParams } from '../lib/sync'

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(fastify: FastifyInstance) {
  fastify.post('/sync', {
    handler: async (request, reply) => {
      const { gteCreated, object } = request.query as { gteCreated?: number; object?: string }
      const params = { gteCreated, object } as SyncBackfillParams
      const result = await syncBackfill(params)
      return reply.send({
        statusCode: 200,
        ts: Date.now(),
        ...result,
      })
    },
  })
}
