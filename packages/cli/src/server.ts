import { FastifyInstance } from 'fastify'
import chalk from 'chalk'
import { createServer } from '@supabase/stripe-sync-fastify/dist/src/app.js'
import { runMigrations } from '@supabase/stripe-sync-engine'

export interface ServerInstance {
  port: number
  apiKey: string
  close: () => Promise<void>
}

/**
 * Start the Fastify server for handling Stripe webhooks.
 * Sets up environment variables required by @supabase/stripe-sync-fastify.
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
    console.log(chalk.blue(`\nStarting Fastify server on port ${port}...`))

    // Generate a random API key for this session
    const apiKey = `dev-${Math.random().toString(36).substring(2, 15)}`

    // Set required environment variables for fastify-app
    process.env.DATABASE_URL = databaseUrl
    process.env.STRIPE_SECRET_KEY = stripeApiKey
    process.env.STRIPE_WEBHOOK_SECRET = stripeWebhookSecret
    process.env.PORT = String(port)
    process.env.API_KEY = apiKey
    process.env.SCHEMA = process.env.SCHEMA || 'stripe'
    process.env.STRIPE_API_VERSION = process.env.STRIPE_API_VERSION || '2020-08-27'
    process.env.AUTO_EXPAND_LISTS = process.env.AUTO_EXPAND_LISTS || 'true'
    process.env.BACKFILL_RELATED_ENTITIES = process.env.BACKFILL_RELATED_ENTITIES || 'true'
    process.env.DISABLE_MIGRATIONS = 'false' // Always run migrations in dev

    // Run migrations first
    console.log(chalk.blue('Running database migrations...'))
    await runMigrations({
      databaseUrl,
      schema: process.env.SCHEMA,
    })
    console.log(chalk.green('✓ Migrations completed'))

    const app: FastifyInstance = await createServer({
      disableRequestLogging: false,
      exposeDocs: false,
    })

    // Start listening
    await app.listen({ port, host: '0.0.0.0' })
    console.log(chalk.green(`✓ Server listening on port ${port}`))

    return {
      port,
      apiKey,
      close: async () => {
        console.log(chalk.blue('\nStopping server...'))
        await app.close()
        console.log(chalk.green('✓ Server stopped'))
      },
    }
  } catch (error) {
    console.error(chalk.red('\nFailed to start server:'))
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    throw error
  }
}
