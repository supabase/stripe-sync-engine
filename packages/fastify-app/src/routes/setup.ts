import { FastifyInstance } from 'fastify'
import { runSetup, setupBodySchema, type SetupRequestBody } from '../internalApi'

export default async function routes(fastify: FastifyInstance) {
  fastify.post<{ Body: SetupRequestBody }>('/setup', {
    schema: {
      body: setupBodySchema,
    },
    handler: async (request, reply) => {
      await runSetup(request.body)

      return reply.send({
        ok: true,
        merchantId: request.body.merchantId,
        schemaName: request.body.merchantConfig.schemaName,
      })
    },
  })
}
