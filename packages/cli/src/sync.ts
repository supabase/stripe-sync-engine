import { runMigrations, StripeSync } from '@supabase/stripe-sync-engine'
import express, { Express } from 'express'
import { type PoolConfig } from 'pg'
import chalk from 'chalk'
import http from 'node:http'

export interface StripeAutoSyncOptions {
  databaseUrl: string
  stripeApiKey: string
  baseUrl: () => string
  schema?: string
  stripeApiVersion?: string
  autoExpandLists?: boolean
  backfillRelatedEntities?: boolean
}

export interface StripeAutoSyncInfo {
  tunnelUrl: string
  webhookUrl: string
  webhookUuid: string
}

/**
 * Manages Stripe webhook auto-sync infrastructure:
 * - Runs database migrations
 * - Creates managed webhook in Stripe
 * - Mounts webhook handler on Express app
 */
export class StripeAutoSync {
  private options: Required<StripeAutoSyncOptions>
  private webhookId: string | null = null
  private webhookUuid: string | null = null
  private stripeSync: StripeSync | null = null

  constructor(options: StripeAutoSyncOptions) {
    this.options = {
      schema: 'stripe',
      stripeApiVersion: '2020-08-27',
      autoExpandLists: false,
      backfillRelatedEntities: true,
      ...options,
    }
  }

  /**
   * Starts the Stripe Sync infrastructure and mounts webhook handler:
   * 1. Runs database migrations
   * 2. Creates StripeSync instance
   * 3. Creates managed webhook endpoint
   * 4. Mounts webhook handler on provided Express app
   *
   * @param app - Express app to mount webhook handler on
   * @returns Information about the running instance
   */
  async start(app: Express): Promise<StripeAutoSyncInfo> {
    try {
      // 1. Run migrations
      await runMigrations({
        databaseUrl: this.options.databaseUrl,
        schema: this.options.schema,
      })

      // 2. Create StripeSync instance (no webhook secret needed)
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

      // 3. Create managed webhook (generates UUID and stores in DB)
      console.log(chalk.blue('\nCreating Stripe webhook endpoint...'))
      const baseUrl = this.options.baseUrl()
      const { webhook, uuid } = await this.stripeSync.createManagedWebhook(
        baseUrl,
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

      // 4. Mount webhook handler on the provided app
      this.mountWebhook(app)

      return {
        tunnelUrl: baseUrl,
        webhookUrl: webhook.url,
        webhookUuid: uuid,
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
   * 1. Deletes Stripe webhook endpoint from Stripe and database
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

    console.log(chalk.green('✓ Webhook cleanup complete'))
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
}
