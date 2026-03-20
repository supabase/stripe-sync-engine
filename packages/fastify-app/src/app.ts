import fastify, { FastifyInstance, FastifyServerOptions } from 'fastify'
import { logger } from './logger'
import healthRoutes from './routes/health'
import setupRoutes from './routes/setup'
import webhookRoutes from './routes/webhooks'

function getErrorStatusCode(error: unknown): number {
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    error.statusCode >= 400
  ) {
    return error.statusCode
  }

  return 500
}

function getErrorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.length > 0
  ) {
    return error.message
  }

  return 'Unknown error'
}

export async function createServer(opts: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = fastify(opts)

  app.setErrorHandler((error, request, reply) => {
    const statusCode = getErrorStatusCode(error)

    logger.error(
      {
        err: error,
        method: request.method,
        path: request.url,
      },
      'Request failed'
    )

    reply.code(statusCode).send({
      error: getErrorMessage(error),
    })
  })

  await app.register(healthRoutes)
  await app.register(setupRoutes)
  await app.register(webhookRoutes)

  await app.ready()

  return app
}
