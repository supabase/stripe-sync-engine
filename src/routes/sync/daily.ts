import { FastifyInstance } from 'fastify'
import { syncBackfill } from '../../lib/sync'

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(fastify: FastifyInstance) {
  fastify.post('/daily', {
    handler: async (request, reply) => {
      const currentTimeInSeconds = Math.floor(Date.now() / 1000)
      const dayAgoTimeInSeconds = currentTimeInSeconds - 60 * 60 * 24

      const result = await syncBackfill(dayAgoTimeInSeconds)
      return reply.send({
        statusCode: 200,
        ts: Date.now(),
        ...result,
      })
    },
  })
}
