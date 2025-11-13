import chalk from 'chalk'
import express from 'express'
import http from 'node:http'
import { loadConfig, CliOptions } from './config'
import { StripeAutoSync } from '@supabase/stripe-sync-engine'
import { createTunnel, NgrokTunnel } from './ngrok'

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
  let stripeSync: StripeAutoSync | null = null
  let tunnel: NgrokTunnel | null = null
  let server: http.Server | null = null

  // Setup cleanup handler
  const cleanup = async (signal?: string) => {
    console.log(chalk.blue(`\n\nCleaning up... (signal: ${signal || 'manual'})`))

    if (stripeSync) {
      await stripeSync.stop()
      console.log(chalk.green('✓ Webhook cleanup complete'))
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
      } catch (error) {
        console.log(chalk.yellow('⚠ Server already stopped'))
      }
    }

    // Close tunnel
    if (tunnel) {
      try {
        await tunnel.close()
      } catch (error) {
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

    // Create ngrok tunnel
    const port = 3000
    tunnel = await createTunnel(port, config.ngrokAuthToken)

    // Create Express app
    const app = express()

    // Create and start sync (runs migrations, creates webhook, mounts handler)
    stripeSync = new StripeAutoSync({
      databaseUrl: config.databaseUrl,
      stripeApiKey: config.stripeApiKey,
      baseUrl: () => tunnel!.url,
      schema: process.env.SCHEMA,
      stripeApiVersion: process.env.STRIPE_API_VERSION,
      autoExpandLists: process.env.AUTO_EXPAND_LISTS === 'true',
      backfillRelatedEntities: process.env.BACKFILL_RELATED_ENTITIES !== 'false',
      keepWebhooksOnShutdown: process.env.KEEP_WEBHOOKS_ON_SHUTDOWN === 'true' ? true : false,
    })

    console.log(chalk.blue('\nCreating Stripe webhook endpoint...'))
    const syncInfo = await stripeSync.start(app)
    console.log(chalk.green(`✓ Webhook created: ${syncInfo.webhookUrl.split('/').pop()}`))
    console.log(chalk.cyan(`  URL: ${syncInfo.webhookUrl}`))
    console.log(chalk.cyan(`  Events: All events (*)`))

    // Body parsing middleware is automatically applied by start()
    // Apply additional JSON parsing as fallback to test middleware protection
    app.use(express.json())
    app.use(express.urlencoded({ extended: false }))

    // Health check endpoint
    app.get('/health', async (req, res) => {
      return res.status(200).json({ status: 'ok' })
    })

    // Start Express server
    console.log(chalk.blue(`\nStarting server on port ${port}...`))
    await new Promise<void>((resolve, reject) => {
      server = app.listen(port, '0.0.0.0', () => {
        resolve()
      })
      server.on('error', reject)
    })
    console.log(chalk.green(`✓ Server started on port ${port}`))

    console.log(chalk.cyan('\n● Streaming live changes...') + chalk.gray(' [press Ctrl-C to abort]'))

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
