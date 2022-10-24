import { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify'
import { getConfig } from './config'

const config = getConfig()

export const verifyApiKey = (
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): unknown => {
  if (!request.headers || !request.headers.authorization) {
    return reply.code(401).send('Unauthorized')
  }
  const { authorization } = request.headers
  if (authorization !== config.API_KEY) {
    return reply.code(401).send('Unauthorized')
  }
  done()
}
