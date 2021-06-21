import { FastifyInstance } from 'fastify'
import { Server, IncomingMessage, ServerResponse } from 'http'
import build from './app'
import { registerWebhooks } from './utils/registerWebhooks'

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


async function main() {
  try {
    await registerWebhooks();
    console.log(`Webhook initialization was successful.`);
  } catch (error) {
    console.error(`Refusing to start due to error on webhook initialization.`);
    console.error(error.message);
    process.exit(1);
  }

  try {
    const address = await app.listen(8080, '0.0.0.0');
    console.log(`Server listening at ${address}`);
  } catch (err) {
    console.error(err)
    process.exit(1)
  }

}

main();