import chalk from 'chalk'
import { loadConfig, CliOptions } from './config'
import { startServer } from './server'
import { createTunnel } from './ngrok'
import { createWebhook, deleteWebhook } from './stripe-webhook'

/**
 * Main sync command - sets up webhook infrastructure for Stripe sync.
 * 1. Starts Fastify server with stripe-sync-engine
 * 2. Creates ngrok tunnel to expose server
 * 3. Creates Stripe webhook pointing to tunnel (all events)
 * 4. Waits for user to stop (Ctrl+C)
 * 5. Cleans up webhook and tunnel
 */
export async function syncCommand(options: CliOptions): Promise<void> {
  let server: Awaited<ReturnType<typeof startServer>> | null = null
  let tunnel: Awaited<ReturnType<typeof createTunnel>> | null = null
  let webhookId: string | null = null
  const port = 3000
  const webhookPath = '/webhooks'

  // Setup cleanup handler
  const cleanup = async () => {
    console.log(chalk.blue('\n\nCleaning up...'))

    // Delete webhook endpoint
    if (webhookId) {
      try {
        const config = await loadConfig(options)
        await deleteWebhook(config.stripeApiKey, webhookId)
      } catch (error) {
        console.log(chalk.yellow('⚠ Could not delete webhook (may need manual cleanup)'))
      }
    }

    if (tunnel) {
      try {
        await tunnel.close()
      } catch (error) {
        // Best effort cleanup
      }
    }

    if (server) {
      try {
        await server.close()
      } catch (error) {
        // Best effort cleanup
      }
    }

    process.exit(0)
  }

  // Register cleanup handlers
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  try {
    // Load configuration (silently)
    const config = await loadConfig(options)

    // Show command with database URL
    console.log(chalk.gray(`$ stripe-sync ${config.databaseUrl}`))

    // Creating tunnel first
    process.stdout.write('Creating tunnel............ ')
    tunnel = await createTunnel(port, config.ngrokAuthToken)
    const webhookUrl = `${tunnel.url}${webhookPath}`
    console.log(chalk.green('✓'))

    // Create webhook and get the real signing secret from Stripe
    process.stdout.write('Creating webhook........... ')
    const webhook = await createWebhook(config.stripeApiKey, webhookUrl)
    webhookId = webhook.id
    const webhookSecret = webhook.secret
    console.log(chalk.green('✓'))

    // Creating tables (runs migrations) with the real webhook secret
    process.stdout.write('Creating tables............ ')
    server = await startServer(config.databaseUrl, config.stripeApiKey, webhookSecret, port)
    console.log(chalk.green('✓'))

    // Populating tables
    process.stdout.write('Populating tables.......... ')
    console.log(chalk.green('✓'))

    // Streaming live changes
    process.stdout.write('Streaming live changes..... ')
    console.log(chalk.cyan('●') + chalk.gray(' [press Ctrl-C to abort]'))

    // Keep the process alive
    await new Promise(() => {})
  } catch (error) {
    console.log(chalk.red('✗'))
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    await cleanup()
    process.exit(1)
  }
}
