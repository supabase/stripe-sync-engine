import Docker from 'dockerode'
import chalk from 'chalk'

export interface ServerInstance {
  port: number
  apiKey: string
  containerId: string
  close: () => Promise<void>
}

/**
 * Start the Docker container for handling Stripe webhooks.
 * Uses the official supabase/stripe-sync-fastify Docker image.
 *
 * @param databaseUrl - Postgres connection string
 * @param stripeApiKey - Stripe secret API key
 * @param stripeWebhookSecret - Webhook signing secret from Stripe
 * @param port - Port to listen on (default: 3000)
 * @returns Server instance with port, apiKey, containerId, and close function
 */
export async function startServer(
  databaseUrl: string,
  stripeApiKey: string,
  stripeWebhookSecret: string,
  port: number = 3000
): Promise<ServerInstance> {
  try {
    console.log(chalk.blue(`\nStarting Dockerized server on port ${port}...`))

    // Generate a random API key for this session
    const apiKey = `dev-${Math.random().toString(36).substring(2, 15)}`

    const docker = new Docker()

    // Map database URL for container access:
    // - Docker Desktop (macOS/Windows): use host.docker.internal
    // - Linux with bridge network: add --add-host parameter
    const containerDatabaseUrl = databaseUrl.replace('localhost', 'host.docker.internal')

    // Create and start container with port mapping (works on all platforms)
    const container = await docker.createContainer({
      Image: 'supabase/stripe-sync-engine:latest',
      Env: [
        `DATABASE_URL=${containerDatabaseUrl}`,
        `STRIPE_SECRET_KEY=${stripeApiKey}`,
        `STRIPE_WEBHOOK_SECRET=${stripeWebhookSecret}`,
        `API_KEY=${apiKey}`,
        `PORT=${port}`,
        `SCHEMA=${process.env.SCHEMA || 'stripe'}`,
        `STRIPE_API_VERSION=${process.env.STRIPE_API_VERSION || '2020-08-27'}`,
        `AUTO_EXPAND_LISTS=${process.env.AUTO_EXPAND_LISTS || 'true'}`,
        `BACKFILL_RELATED_ENTITIES=${process.env.BACKFILL_RELATED_ENTITIES || 'true'}`,
        'DISABLE_MIGRATIONS=false',
      ],
      ExposedPorts: {
        [`${port}/tcp`]: {},
      },
      HostConfig: {
        PortBindings: {
          [`${port}/tcp`]: [{ HostPort: `${port}` }],
        },
        // On Linux, map host.docker.internal to host gateway IP
        ExtraHosts: ['host.docker.internal:host-gateway'],
        AutoRemove: true,
      },
    })

    await container.start()

    const containerId = container.id

    // Wait for container to be ready
    await new Promise(resolve => setTimeout(resolve, 3000))

    console.log(chalk.green(`✓ Dockerized server started: ${containerId.substring(0, 12)}`))

    return {
      port,
      apiKey,
      containerId,
      close: async () => {
        console.log(chalk.blue('\nStopping Docker container...'))
        try {
          await container.stop()
          console.log(chalk.green('✓ Docker container stopped'))
        } catch (error) {
          // Container might already be stopped
          console.log(chalk.yellow('⚠ Container already stopped'))
        }
      },
    }
  } catch (error) {
    console.error(chalk.red('\nFailed to start Dockerized server:'))
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    throw error
  }
}
