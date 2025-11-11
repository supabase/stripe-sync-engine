import Stripe from 'stripe'
import chalk from 'chalk'

export interface WebhookEndpoint {
  id: string
  url: string
  secret: string
}

/**
 * Create a Stripe webhook endpoint that forwards all events to the ngrok tunnel.
 * @param stripeApiKey - Stripe secret API key
 * @param webhookUrl - The ngrok tunnel URL + webhook path
 * @returns The created webhook endpoint
 */
export async function createWebhook(
  stripeApiKey: string,
  webhookUrl: string
): Promise<WebhookEndpoint> {
  try {
    console.log(chalk.blue('\nCreating Stripe webhook endpoint...'))

    const stripe = new Stripe(stripeApiKey)

    const webhook = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: ['*'], // Subscribe to all events
      description: 'stripe-sync-cli development webhook',
    })

    console.log(chalk.green(`✓ Webhook created: ${webhook.id}`))
    console.log(chalk.cyan(`  URL: ${webhook.url}`))
    console.log(chalk.cyan(`  Events: All events (*)`))

    return {
      id: webhook.id,
      url: webhook.url,
      secret: webhook.secret || '',
    }
  } catch (error) {
    console.error(chalk.red('\nFailed to create Stripe webhook:'))
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    throw error
  }
}

/**
 * Delete a Stripe webhook endpoint.
 * @param stripeApiKey - Stripe secret API key
 * @param webhookId - The webhook endpoint ID to delete
 */
export async function deleteWebhook(
  stripeApiKey: string,
  webhookId: string
): Promise<void> {
  try {
    console.log(chalk.blue(`\nDeleting Stripe webhook ${webhookId}...`))

    const stripe = new Stripe(stripeApiKey)
    await stripe.webhookEndpoints.del(webhookId)

    console.log(chalk.green('✓ Webhook deleted'))
  } catch (error) {
    console.error(chalk.red('\nFailed to delete Stripe webhook:'))
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    // Don't throw - cleanup should be best-effort
  }
}
