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
    exposeDocs: getConfig().NODE_ENV !== 'production',
    requestIdHeader: 'Request-Id',
  })

  await runMigrations()

  // Start the server
  app.listen({ port: Number(config.PORT), host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err)
      process.exit(1)
    }
    console.log(`Server listening at ${address}`)
  })
}

main()
