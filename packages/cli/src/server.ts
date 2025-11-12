import { runMigrations, StripeSync } from '@supabase/stripe-sync-engine'
import express, { Express } from 'express'
import { type PoolConfig } from 'pg'
import chalk from 'chalk'
import { createTunnel, NgrokTunnel } from './ngrok'
import http from 'node:http'

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
 * - Starts Express server with webhook handler
 */
export class StripeSyncServer {
  private options: Required<StripeSyncServerOptions>
  private tunnel: NgrokTunnel | null = null
  private app: Express | null = null
  private server: http.Server | null = null
  private webhookId: string | null = null
  private webhookUuid: string | null = null
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
   * 2. Runs database migrations
   * 3. Creates StripeSync instance
   * 4. Creates managed webhook endpoint
   * 5. Starts Fastify server
   *
   * @returns Information about the running instance
   */
  async start(): Promise<StripeSyncServerInfo> {
    try {
      // 1. Create tunnel
      this.tunnel = await createTunnel(this.options.port, this.options.ngrokAuthToken)

      // 2. Run migrations
      await runMigrations({
        databaseUrl: this.options.databaseUrl,
        schema: this.options.schema,
      })

      // 3. Create StripeSync instance (no webhook secret needed)
      const poolConfig: PoolConfig = {
        max: 10,
        connectionString: this.options.databaseUrl,
        keepAlive: true,
      }

      this.stripeSync = new StripeSync({
        databaseUrl: this.options.databaseUrl,
        schema: this.options.schema,
        stripeSecretKey: this.options.stripeApiKey,
        stripeApiVersion: this.options.stripeApiVersion,
        autoExpandLists: this.options.autoExpandLists,
        backfillRelatedEntities: this.options.backfillRelatedEntities,
        poolConfig,
      })

      // 4. Create managed webhook (generates UUID and stores in DB)
      console.log(chalk.blue('\nCreating Stripe webhook endpoint...'))
      const { webhook, uuid } = await this.stripeSync.createManagedWebhook(
        this.tunnel.url,
        {
          enabled_events: ['*'], // Subscribe to all events
          description: 'stripe-sync-cli development webhook',
        }
      )
      this.webhookId = webhook.id
      this.webhookUuid = uuid

      console.log(chalk.green(`✓ Webhook created: ${webhook.id}`))
      console.log(chalk.cyan(`  URL: ${webhook.url}`))
      console.log(chalk.cyan(`  Events: All events (*)`))

      // 5. Start Express server
      console.log(chalk.blue(`\nStarting server on port ${this.options.port}...`))
      this.app = this.createExpressServer()

      // Wrap Express listen in a promise
      await new Promise<void>((resolve, reject) => {
        this.server = this.app!.listen(this.options.port, '0.0.0.0', () => {
          resolve()
        })
        this.server.on('error', reject)
      })

      console.log(chalk.green(`✓ Server started on port ${this.options.port}`))

      return {
        tunnelUrl: this.tunnel.url,
        webhookUrl: webhook.url,
        port: this.options.port,
      }
    } catch (error) {
      console.log(chalk.red('\nFailed to start Stripe Sync:'))
      if (error instanceof Error) {
        console.error(chalk.red(error.message))
        console.error(chalk.red(error.stack || ''))
      } else {
        console.error(chalk.red(String(error)))
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
   * 3. Closes Express server
   */
  async stop(): Promise<void> {
    // Delete webhook endpoint using StripeSync
    if (this.webhookId && this.stripeSync) {
      try {
        await this.stripeSync.deleteManagedWebhook(this.webhookId)
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
    if (this.server) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.server!.close((err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        console.log(chalk.green('✓ Server stopped'))
      } catch (error) {
        console.log(chalk.yellow('⚠ Server already stopped'))
      }
    }

    console.log(chalk.green('✓ Cleanup complete'))
  }

  /**
   * Mounts the Stripe webhook handler on the provided Express app.
   * Applies raw body parser middleware for signature verification.
   * IMPORTANT: Must be called BEFORE app.use(express.json()) to ensure raw body parsing.
   */
  private mountWebhook(app: Express): void {
    // Apply raw body parser ONLY to this webhook route
    app.use('/webhooks/:uuid', express.raw({ type: 'application/json' }))

    // Mount the webhook handler
    app.post('/webhooks/:uuid', async (req, res) => {
      const sig = req.headers['stripe-signature']
      if (!sig || typeof sig !== 'string') {
        console.error('[Webhook] Missing stripe-signature header')
        return res.status(400).send({ error: 'Missing stripe-signature header' })
      }

      const { uuid } = req.params

      // express.raw puts the raw body in req.body as a Buffer
      const rawBody = req.body
      if (!rawBody || !Buffer.isBuffer(rawBody)) {
        console.error('[Webhook] Body is not a Buffer!', {
          hasBody: !!rawBody,
          bodyType: typeof rawBody,
          isBuffer: Buffer.isBuffer(rawBody),
          bodyConstructor: rawBody?.constructor?.name,
        })
        return res.status(400).send({ error: 'Missing raw body for signature verification' })
      }

      try {
        // Process webhook with Stripe Sync Engine
        await this.stripeSync!.processWebhook(rawBody, sig, uuid)

        return res.status(200).send({ received: true })
      } catch (error: any) {
        console.error('[Webhook] Processing error:', error.message)
        return res.status(400).send({ error: error.message })
      }
    })
  }

  /**
   * Creates and configures the Express server with webhook handling.
   */
  private createExpressServer(): Express {
    const app = express()

    // Mount webhook handler FIRST (before any other middleware)
    this.mountWebhook(app)

    // Health check
    app.get('/health', async (req, res) => {
      return res.status(200).json({ status: 'ok' })
    })

    return app
  }
}
