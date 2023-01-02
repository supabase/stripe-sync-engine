import { FastifyInstance } from 'fastify'
import { Server, IncomingMessage, ServerResponse } from 'http'
import { runMigrations } from './utils/migrate'
import { createServer } from './app'
import pino from 'pino'

const logger = pino({
  formatters: {
    level(label) {
      return { level: label }
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
})

const main = async () => {
  const app: FastifyInstance<Server, IncomingMessage, ServerResponse> = await createServer({
    logger,
    exposeDocs: process.env.NODE_ENV !== 'production',
    requestIdHeader: 'Request-Id',
  })

  // Init config
  const port = process.env.PORT || 8080

  // Run migrations
  await runMigrations()

  // Start the server
  app.listen({ port: Number(port), host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err)
      process.exit(1)
    }
    console.log(`Server listening at ${address}`)
  })
}

main()
