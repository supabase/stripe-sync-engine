import { FastifyInstance } from 'fastify'

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
