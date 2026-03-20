import { FastifyInstance } from 'fastify'
import { Server, IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from './app'
import { getServerConfig } from './utils/config'
import { logger } from './logger'

const main = async () => {
  const app: FastifyInstance<Server, IncomingMessage, ServerResponse> = await createServer({
    loggerInstance: logger,
    disableRequestLogging: true,
    requestIdHeader: 'Request-Id',
  })

  const config = getServerConfig()
  const address = await app.listen({ port: config.port, host: '0.0.0.0' })
  logger.info({ address }, 'Server listening')
}

main().catch((error) => {
  logger.error({ err: error }, 'Failed to start server')
  process.exit(1)
})
