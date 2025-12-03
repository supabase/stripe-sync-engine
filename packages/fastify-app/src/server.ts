import { FastifyInstance } from 'fastify'
import { Server, IncomingMessage, ServerResponse } from 'node:http'
import { runMigrations } from 'stripe-experiment-sync'
import { PgAdapter } from 'stripe-experiment-sync/pg'
import { createServer } from './app'
import { getConfig } from './utils/config'
import { logger } from './logger'

const main = async () => {
  const app: FastifyInstance<Server, IncomingMessage, ServerResponse> = await createServer({
    loggerInstance: logger,
    disableRequestLogging: true,
    exposeDocs: false,
    requestIdHeader: 'Request-Id',
  })

  const config = getConfig()

  if (!config.disableMigrations) {
    const adapter = new PgAdapter({
      connectionString: config.databaseUrl,
      ssl: config.sslConnectionOptions,
    })
    await runMigrations(adapter, logger)
    await adapter.end()
  }

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
