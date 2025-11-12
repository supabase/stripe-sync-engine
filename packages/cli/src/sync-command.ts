import chalk from 'chalk'
import { loadConfig, CliOptions } from './config'
import { StripeSyncServer } from './sync'

/**
 * Main sync command - sets up webhook infrastructure for Stripe sync.
 * 1. Creates ngrok tunnel to expose server
 * 2. Creates Stripe webhook pointing to tunnel (all events)
 * 3. Runs database migrations
 * 4. Starts Fastify server with stripe-sync-engine
 * 5. Waits for user to stop (Ctrl+C)
 * 6. Cleans up webhook and tunnel
 */
export async function syncCommand(options: CliOptions): Promise<void> {
  let syncServer: StripeSyncServer | null = null

  // Setup cleanup handler
  const cleanup = async (signal?: string) => {
    console.log(chalk.blue(`\n\nCleaning up... (signal: ${signal || 'manual'})`))

    if (syncServer) {
      await syncServer.stop()
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

    // Create and start sync server
    syncServer = new StripeSyncServer({
      databaseUrl: config.databaseUrl,
      stripeApiKey: config.stripeApiKey,
      ngrokAuthToken: config.ngrokAuthToken,
      port: 3000,
      webhookPath: '/webhooks',
      schema: process.env.SCHEMA,
      stripeApiVersion: process.env.STRIPE_API_VERSION,
      autoExpandLists: process.env.AUTO_EXPAND_LISTS === 'true',
      backfillRelatedEntities: process.env.BACKFILL_RELATED_ENTITIES !== 'false',
    })

    await syncServer.start()

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
