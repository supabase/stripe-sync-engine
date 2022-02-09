import { FastifyInstance } from 'fastify'
import { syncBackfill } from '../../lib/sync'

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(fastify: FastifyInstance) {
  fastify.post('/weekly', {
    handler: async (request, reply) => {
      var currentTimeInSeconds = Math.floor(Date.now() / 1000)
      var weekAgoTimeInSeconds = currentTimeInSeconds - 60 * 60 * 24 * 7

      const result = await syncBackfill(weekAgoTimeInSeconds)
      return reply.send({
        statusCode: 200,
        ts: Date.now(),
        ...result,
      })
    },
  })
}
