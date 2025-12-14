#!/usr/bin/env tsx

/**
 * Cleanup script to delete all test webhook endpoints from Stripe.
 * Use this when you've hit the 16 webhook endpoint limit.
 */

import Stripe from 'stripe'
import dotenv from 'dotenv'
import chalk from 'chalk'

// Load environment variables
dotenv.config()

const STRIPE_API_KEY = process.env.STRIPE_API_KEY

if (!STRIPE_API_KEY) {
  console.error(chalk.red('❌ Missing STRIPE_API_KEY environment variable'))
  process.exit(1)
}

async function main() {
  console.log(chalk.blue('\n🧹 Cleaning up Stripe webhook endpoints'))
  console.log(chalk.blue('=========================================\n'))

  const stripe = new Stripe(STRIPE_API_KEY, {
    apiVersion: '2020-08-27',
  })

  try {
    // List all webhook endpoints
    console.log(chalk.gray('Fetching all webhook endpoints...'))
    const webhooks = await stripe.webhookEndpoints.list({ limit: 100 })

    if (webhooks.data.length === 0) {
      console.log(chalk.green('✓ No webhook endpoints found'))
      return
    }

    console.log(chalk.cyan(`Found ${webhooks.data.length} webhook endpoint(s)\n`))

    // Delete each webhook
    for (const webhook of webhooks.data) {
      try {
        console.log(chalk.gray(`Deleting: ${webhook.id} (${webhook.url})`))
        await stripe.webhookEndpoints.del(webhook.id)
        console.log(chalk.green(`  ✓ Deleted ${webhook.id}`))
      } catch (error) {
        console.log(chalk.yellow(`  ⚠ Failed to delete ${webhook.id}: ${error}`))
      }
    }

    console.log()
    console.log(chalk.green('✅ Cleanup complete!'))
    console.log()
  } catch (error) {
    console.error(chalk.red('\n❌ Error during cleanup:'))
    console.error(error)
    process.exit(1)
  }
}

main()
