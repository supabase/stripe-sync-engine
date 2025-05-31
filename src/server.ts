import { FastifyInstance } from 'fastify'
import { Server, IncomingMessage, ServerResponse } from 'node:http'
import { runMigrations } from './utils/migrate'
import { createServer } from './app'
import { getConfig } from './utils/config'
import { logger } from './logger'

const config = getConfig()

const main = async () => {
  const app: FastifyInstance<Server, IncomingMessage, ServerResponse> = await createServer({
    loggerInstance: logger,
    disableRequestLogging: true,
    exposeDocs: getConfig().nodeEnv !== 'production',
    requestIdHeader: 'Request-Id',
  })

  await runMigrations()

  // Start the server
  app.listen({ port: Number(config.port), host: '0.0.0.0' }, (err, address) => {
    if (err) {
      logger.error(err)
      process.exit(1)
    }
    logger.info(`Server listening at ${address}`)
  })
}

main()
