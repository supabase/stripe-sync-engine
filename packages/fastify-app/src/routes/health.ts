import { FastifyInstance } from 'fastify'

export default async function routes(fastify: FastifyInstance) {
  fastify.get('/health', {
    handler: async (_request, reply) => {
      return reply.send({
        ok: true,
      })
    },
  })
}
