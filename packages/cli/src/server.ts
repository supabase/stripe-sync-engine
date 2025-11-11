import { runMigrations, StripeSync } from '@supabase/stripe-sync-engine'
import fastify, { FastifyInstance } from 'fastify'
import { type PoolConfig } from 'pg'
import chalk from 'chalk'

// TODO: Ideally we would import createServer from '@supabase/stripe-sync-fastify/src/app'
// but there's an ESM/CommonJS module mismatch (CLI is ESM, fastify-app is CommonJS).
// For now, we build the server inline using StripeSync directly.

export interface ServerInstance {
  port: number
  apiKey: string
  close: () => Promise<void>
}

/**
 * Start the Fastify server for handling Stripe webhooks using library mode.
 * Runs migrations and starts the sync engine directly without Docker.
 *
 * @param databaseUrl - Postgres connection string
 * @param stripeApiKey - Stripe secret API key
 * @param stripeWebhookSecret - Webhook signing secret from Stripe
 * @param port - Port to listen on (default: 3000)
 * @returns Server instance with port, apiKey, and close function
 */
export async function startServer(
  databaseUrl: string,
  stripeApiKey: string,
  stripeWebhookSecret: string,
  port: number = 3000
): Promise<ServerInstance> {
  try {
    const apiKey = `dev-${Math.random().toString(36).substring(2, 15)}`
    const schema = process.env.SCHEMA || 'stripe'

    // Run migrations
    await runMigrations({
      databaseUrl,
      schema,
    })

    // Create StripeSync instance
    const poolConfig: PoolConfig = {
      max: 10,
      connectionString: databaseUrl,
      keepAlive: true,
    }

    const stripeSync = new StripeSync({
      databaseUrl,
      schema,
      stripeSecretKey: stripeApiKey,
      stripeWebhookSecret,
      stripeApiVersion: process.env.STRIPE_API_VERSION || '2020-08-27',
      autoExpandLists: process.env.AUTO_EXPAND_LISTS === 'true',
      backfillRelatedEntities: process.env.BACKFILL_RELATED_ENTITIES !== 'false',
      poolConfig,
    })

    console.log(chalk.blue(`\nStarting server on port ${port}...`))

    // Create Fastify app
    const app: FastifyInstance = fastify({
      disableRequestLogging: true,
    })

    // Add webhook content parser (needs raw buffer for signature verification)
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      try {
        const newBody = req.routeOptions.url === '/webhooks'
          ? { raw: body }
          : JSON.parse(body.toString())
        done(null, newBody)
      } catch (error: any) {
        error.statusCode = 400
        done(error, undefined)
      }
    })

    // Webhook route
    app.post('/webhooks', async (request, reply) => {
      const sig = request.headers['stripe-signature']
      if (!sig || typeof sig !== 'string') {
        return reply.code(400).send({ error: 'Missing stripe-signature header' })
      }

      try {
        const body = (request.body as any).raw
        await stripeSync.processWebhook(body, sig)
        return reply.code(200).send({ received: true })
      } catch (error: any) {
        request.log.error(error)
        return reply.code(400).send({ error: error.message })
      }
    })

    // Health check
    app.get('/health', async (request, reply) => {
      return reply.code(200).send({ status: 'ok' })
    })

    await app.listen({ port, host: '0.0.0.0' })

    console.log(chalk.green(`✓ Server started on port ${port}`))

    return {
      port,
      apiKey,
      close: async () => {
        console.log(chalk.blue('\nStopping server...'))
        try {
          await app.close()
          console.log(chalk.green('✓ Server stopped'))
        } catch (error) {
          console.log(chalk.yellow('⚠ Server already stopped'))
        }
      },
    }
  } catch (error) {
    console.log(chalk.red('\nFailed to start server:'))
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    throw error
  }
}
