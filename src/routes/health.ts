import { FastifyInstance } from 'fastify'

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(fastify: FastifyInstance) {
  fastify.get('/health', {
    handler: async (request, reply) => {
      return reply.send({
        received: true,
        statusCode: 200,
        ts: Date.now(),
      })
    },
  })
}
