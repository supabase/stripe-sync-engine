import { runMigrations, StripeSync } from '@supabase/stripe-sync-engine'
import fastify, { FastifyInstance } from 'fastify'
import { type PoolConfig } from 'pg'
import chalk from 'chalk'
import { createTunnel, NgrokTunnel } from './ngrok'
import { createWebhook, deleteWebhook } from './stripe-webhook'

export interface StripeSyncServerOptions {
  databaseUrl: string
  stripeApiKey: string
  ngrokAuthToken: string
  port?: number
  webhookPath?: string
  schema?: string
  stripeApiVersion?: string
  autoExpandLists?: boolean
  backfillRelatedEntities?: boolean
}

export interface StripeSyncServerInfo {
  tunnelUrl: string
  webhookUrl: string
  port: number
}

/**
 * Encapsulates the entire Stripe Sync orchestration:
 * - Creates ngrok tunnel
 * - Sets up Stripe webhook
 * - Runs database migrations
 * - Starts Fastify server with webhook handler
 */
export class StripeSyncServer {
  private options: Required<StripeSyncServerOptions>
  private tunnel: NgrokTunnel | null = null
  private app: FastifyInstance | null = null
  private webhookId: string | null = null
  private stripeSync: StripeSync | null = null

  constructor(options: StripeSyncServerOptions) {
    this.options = {
      port: 3000,
      webhookPath: '/webhooks',
      schema: 'stripe',
      stripeApiVersion: '2020-08-27',
      autoExpandLists: false,
      backfillRelatedEntities: true,
      ...options,
    }
  }

  /**
   * Starts the complete Stripe Sync infrastructure:
   * 1. Creates ngrok tunnel
   * 2. Creates Stripe webhook endpoint
   * 3. Runs database migrations
   * 4. Starts Fastify server
   *
   * @returns Information about the running instance
   */
  async start(): Promise<StripeSyncServerInfo> {
    try {
      // 1. Create tunnel
      this.tunnel = await createTunnel(this.options.port, this.options.ngrokAuthToken)
      const webhookUrl = `${this.tunnel.url}${this.options.webhookPath}`

      // 2. Create webhook and get the signing secret
      const webhook = await createWebhook(this.options.stripeApiKey, webhookUrl)
      this.webhookId = webhook.id
      const webhookSecret = webhook.secret

      // 3. Run migrations
      await runMigrations({
        databaseUrl: this.options.databaseUrl,
        schema: this.options.schema,
      })

      // 4. Create StripeSync instance
      const poolConfig: PoolConfig = {
        max: 10,
        connectionString: this.options.databaseUrl,
        keepAlive: true,
      }

      this.stripeSync = new StripeSync({
        databaseUrl: this.options.databaseUrl,
        schema: this.options.schema,
        stripeSecretKey: this.options.stripeApiKey,
        stripeWebhookSecret: webhookSecret,
        stripeApiVersion: this.options.stripeApiVersion,
        autoExpandLists: this.options.autoExpandLists,
        backfillRelatedEntities: this.options.backfillRelatedEntities,
        poolConfig,
      })

      // 5. Start Fastify server
      console.log(chalk.blue(`\nStarting server on port ${this.options.port}...`))
      this.app = this.createFastifyServer()
      await this.app.listen({ port: this.options.port, host: '0.0.0.0' })
      console.log(chalk.green(`✓ Server started on port ${this.options.port}`))

      return {
        tunnelUrl: this.tunnel.url,
        webhookUrl,
        port: this.options.port,
      }
    } catch (error) {
      console.log(chalk.red('\nFailed to start Stripe Sync:'))
      if (error instanceof Error) {
        console.error(chalk.red(error.message))
      }
      // Clean up on error
      await this.stop()
      throw error
    }
  }

  /**
   * Stops all services and cleans up resources:
   * 1. Deletes Stripe webhook endpoint
   * 2. Closes ngrok tunnel
   * 3. Closes Fastify server
   */
  async stop(): Promise<void> {
    // Delete webhook endpoint
    if (this.webhookId) {
      try {
        await deleteWebhook(this.options.stripeApiKey, this.webhookId)
      } catch (error) {
        console.log(chalk.yellow('⚠ Could not delete webhook'))
      }
    }

    // Close tunnel
    if (this.tunnel) {
      try {
        await this.tunnel.close()
      } catch (error) {
        console.log(chalk.yellow('⚠ Could not close tunnel'))
      }
    }

    // Close server
    if (this.app) {
      try {
        await this.app.close()
        console.log(chalk.green('✓ Server stopped'))
      } catch (error) {
        console.log(chalk.yellow('⚠ Server already stopped'))
      }
    }

    console.log(chalk.green('✓ Cleanup complete'))
  }

  /**
   * Creates and configures the Fastify server with webhook handling.
   */
  private createFastifyServer(): FastifyInstance {
    const app = fastify({
      disableRequestLogging: true,
    })

    // Add webhook content parser (needs raw buffer for signature verification)
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      try {
        const newBody = req.routeOptions.url === this.options.webhookPath
          ? { raw: body }
          : JSON.parse(body.toString())
        done(null, newBody)
      } catch (error: any) {
        error.statusCode = 400
        done(error, undefined)
      }
    })

    // Webhook route
    app.post(this.options.webhookPath, async (request, reply) => {
      const sig = request.headers['stripe-signature']
      if (!sig || typeof sig !== 'string') {
        return reply.code(400).send({ error: 'Missing stripe-signature header' })
      }

      try {
        const body = (request.body as any).raw
        await this.stripeSync!.processWebhook(body, sig)
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

    return app
  }
}
