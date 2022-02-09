import { FastifyInstance } from 'fastify'
import { syncBackfill } from '../../lib/sync'

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(fastify: FastifyInstance) {
  fastify.post('/all', {
    handler: async (request, reply) => {
      const result = await syncBackfill()
      return reply.send({
        statusCode: 200,
        ts: Date.now(),
        ...result,
      })
    },
  })
}
