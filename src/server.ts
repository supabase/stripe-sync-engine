import { FastifyInstance } from 'fastify'
import { Server, IncomingMessage, ServerResponse } from 'http'
import { runMigrations } from './utils/migrate'
import build from './app'

const loggerConfig = {
  prettyPrint: true,
}
let exposeDocs = true
if (process.env.NODE_ENV === 'production') {
  loggerConfig.prettyPrint = false
  exposeDocs = true
}
const app: FastifyInstance<Server, IncomingMessage, ServerResponse> = build({
  logger: loggerConfig,
  exposeDocs,
})

const main = async () => {
  // Init config
  const port = process.env.PORT || 8080

  // Run migrations
  await runMigrations()

  // Start the server
  app.listen(port, '0.0.0.0', (err, address) => {
    if (err) {
      console.error(err)
      process.exit(1)
    }
    console.log(`Server listening at ${address}`)
  })
}

main()
