import chalk from 'chalk'
import express from 'express'
import http from 'node:http'
import { loadConfig, CliOptions } from './config'
import { StripeSync, runMigrations } from 'stripe-replit-sync'
import { createTunnel, NgrokTunnel } from './ngrok'
import type { PoolConfig } from 'pg'

/**
 * Main sync command - sets up webhook infrastructure for Stripe sync.
 * 1. Creates ngrok tunnel to expose server
 * 2. Creates Stripe webhook pointing to tunnel (all events)
 * 3. Runs database migrations
 * 4. Starts Express server with stripe-sync-engine
 * 5. Waits for user to stop (Ctrl+C)
 * 6. Cleans up webhook, server, and tunnel
 */
export async function syncCommand(options: CliOptions): Promise<void> {
  let stripeSync: StripeSync | null = null
  let tunnel: NgrokTunnel | null = null
  let server: http.Server | null = null
  let webhookId: string | null = null

  // Setup cleanup handler
  const cleanup = async (signal?: string) => {
    console.log(chalk.blue(`\n\nCleaning up... (signal: ${signal || 'manual'})`))

    // Delete webhook endpoint if created (unless keepWebhooksOnShutdown is true)
    const keepWebhooksOnShutdown = process.env.KEEP_WEBHOOKS_ON_SHUTDOWN === 'true'
    if (webhookId && stripeSync && !keepWebhooksOnShutdown) {
      try {
        await stripeSync.deleteManagedWebhook(webhookId)
        console.log(chalk.green('✓ Webhook cleanup complete'))
      } catch {
        console.log(chalk.yellow('⚠ Could not delete webhook'))
      }
    }

    // Close server
    if (server) {
      try {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        console.log(chalk.green('✓ Server stopped'))
      } catch {
        console.log(chalk.yellow('⚠ Server already stopped'))
      }
    }

    // Close tunnel
    if (tunnel) {
      try {
        await tunnel.close()
      } catch {
        console.log(chalk.yellow('⚠ Could not close tunnel'))
      }
    }

    process.exit(0)
  }

  // Register cleanup handlers
  process.on('SIGINT', () => cleanup('SIGINT'))
  process.on('SIGTERM', () => cleanup('SIGTERM'))

  try {
    // Load configuration
    const config = await loadConfig(options)

    // Show command with database URL
    console.log(chalk.gray(`$ stripe-sync ${config.databaseUrl}`))

    // 1. Run migrations
    const schema = process.env.SCHEMA || 'stripe'
    try {
      await runMigrations({
        databaseUrl: config.databaseUrl,
        schema,
      })
    } catch (migrationError) {
      // Migration failed - drop schema and retry
      console.warn(chalk.yellow('Migration failed, dropping schema and retrying...'))
      console.warn(
        'Migration error:',
        migrationError instanceof Error ? migrationError.message : String(migrationError)
      )

      const { Client } = await import('pg')
      const client = new Client({ connectionString: config.databaseUrl })

      try {
        await client.connect()
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        console.log(chalk.green(`✓ Dropped schema: ${schema}`))
      } finally {
        await client.end()
      }

      // Retry migrations
      console.log('Retrying migrations...')
      await runMigrations({
        databaseUrl: config.databaseUrl,
        schema,
      })
      console.log(chalk.green('✓ Migrations completed successfully after retry'))
    }

    // 2. Create ngrok tunnel
    const port = 3000
    tunnel = await createTunnel(port, config.ngrokAuthToken)

    // 3. Create StripeSync instance
    const poolConfig: PoolConfig = {
      max: 10,
      connectionString: config.databaseUrl,
      keepAlive: true,
    }

    stripeSync = new StripeSync({
      databaseUrl: config.databaseUrl,
      schema,
      stripeSecretKey: config.stripeApiKey,
      stripeApiVersion: process.env.STRIPE_API_VERSION || '2020-08-27',
      autoExpandLists: process.env.AUTO_EXPAND_LISTS === 'true',
      backfillRelatedEntities: process.env.BACKFILL_RELATED_ENTITIES !== 'false',
      poolConfig,
    })

    // 4. Create managed webhook endpoint
    const webhookPath = process.env.WEBHOOK_PATH || '/stripe-webhooks'
    console.log(chalk.blue('\nCreating Stripe webhook endpoint...'))
    const { webhook, uuid } = await stripeSync.findOrCreateManagedWebhook(
      `${tunnel.url}${webhookPath}`,
      {
        enabled_events: ['*'], // Subscribe to all events
        description: 'stripe-sync-cli development webhook',
      }
    )
    webhookId = webhook.id
    console.log(chalk.green(`✓ Webhook created: ${uuid}`))
    console.log(chalk.cyan(`  URL: ${webhook.url}`))
    console.log(chalk.cyan(`  Events: All events (*)`))

    // 5. Create Express app and mount webhook handler
    const app = express()

    // Mount webhook handler with raw body parser (BEFORE any other body parsing)
    const webhookRoute = `${webhookPath}/:uuid`
    app.use(webhookRoute, express.raw({ type: 'application/json' }))

    app.post(webhookRoute, async (req, res) => {
      const sig = req.headers['stripe-signature']
      if (!sig || typeof sig !== 'string') {
        console.error('[Webhook] Missing stripe-signature header')
        return res.status(400).send({ error: 'Missing stripe-signature header' })
      }

      const { uuid } = req.params
      const rawBody = req.body

      if (!rawBody || !Buffer.isBuffer(rawBody)) {
        console.error('[Webhook] Body is not a Buffer!')
        return res.status(400).send({ error: 'Missing raw body for signature verification' })
      }

      try {
        await stripeSync!.processWebhook(rawBody, sig, uuid)
        return res.status(200).send({ received: true })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        console.error('[Webhook] Processing error:', errorMessage)
        return res.status(400).send({ error: errorMessage })
      }
    })

    // Apply body parsing middleware for other routes (after webhook handler)
    app.use(express.json())
    app.use(express.urlencoded({ extended: false }))

    // Health check endpoint
    app.get('/health', async (req, res) => {
      return res.status(200).json({ status: 'ok' })
    })

    // 6. Start Express server
    console.log(chalk.blue(`\nStarting server on port ${port}...`))
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '0.0.0.0', () => {
        resolve()
      })
      server.on('error', reject)
    })
    console.log(chalk.green(`✓ Server started on port ${port}`))

    // 7. Run initial backfill of all Stripe data
    console.log(chalk.blue('\nStarting initial backfill of all Stripe data...'))
    const backfillResult = await stripeSync.syncBackfill({ object: 'all' })
    const totalSynced = Object.values(backfillResult).reduce(
      (sum, result) => sum + (result?.synced || 0),
      0
    )
    console.log(chalk.green(`✓ Backfill complete: ${totalSynced} objects synced`))

    console.log(
      chalk.cyan('\n● Streaming live changes...') + chalk.gray(' [press Ctrl-C to abort]')
    )

    // Keep the process alive
    await new Promise(() => {})
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    await cleanup()
    process.exit(1)
  }
}
