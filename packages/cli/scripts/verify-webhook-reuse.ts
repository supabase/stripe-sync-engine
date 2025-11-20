#!/usr/bin/env tsx

/**
 * Manual verification script for webhook reuse functionality.
 * Tests that findOrCreateManagedWebhook correctly reuses existing webhooks
 * when the base URL matches, and creates new ones when it doesn't.
 */

import { StripeSync, runMigrations } from 'stripe-replit-sync'
import dotenv from 'dotenv'
import chalk from 'chalk'
import type { PoolConfig } from 'pg'

// Load environment variables
dotenv.config()

const STRIPE_API_KEY = process.env.STRIPE_API_KEY
const DATABASE_URL = process.env.DATABASE_URL

if (!STRIPE_API_KEY || !DATABASE_URL) {
  console.error(chalk.red('❌ Missing required environment variables'))
  console.error(chalk.yellow('   Required: STRIPE_API_KEY, DATABASE_URL'))
  process.exit(1)
}

async function main() {
  console.log(chalk.blue('\n🧪 Webhook Reuse Verification Script'))
  console.log(chalk.blue('=====================================\n'))

  const createdWebhookIds: string[] = []

  try {
    // Run migrations first
    await runMigrations({
      databaseUrl: DATABASE_URL!,
    })

    // Create StripeSync instance
    const poolConfig: PoolConfig = {
      max: 10,
      connectionString: DATABASE_URL!,
      keepAlive: true,
    }

    const stripeSync = new StripeSync({
      databaseUrl: DATABASE_URL!,
      stripeSecretKey: STRIPE_API_KEY!,
      stripeApiVersion: '2020-08-27',
      poolConfig,
    })

    // Test 1: Create initial webhook with first base URL
    console.log(chalk.blue('📝 Test 1: Create initial webhook'))
    console.log(chalk.gray('   Base URL: https://test1.example.com/stripe-webhooks'))

    const result1 = await stripeSync.findOrCreateManagedWebhook(
      'https://test1.example.com/stripe-webhooks',
      {
        enabled_events: ['*'],
        description: 'stripe-sync-cli test webhook 1',
      }
    )
    const webhookId1 = result1.webhook.id
    const webhookUuid1 = result1.uuid

    createdWebhookIds.push(webhookId1)

    console.log(chalk.green('   ✓ Webhook created'))
    console.log(chalk.cyan(`   - Webhook ID: ${webhookId1}`))
    console.log(chalk.cyan(`   - UUID: ${webhookUuid1}`))
    console.log(chalk.cyan(`   - URL: ${result1.webhook.url}`))
    console.log()

    // Test 2: Call findOrCreateManagedWebhook again with same base URL (should reuse)
    console.log(chalk.blue('📝 Test 2: Retry with same base URL'))
    console.log(chalk.gray('   Base URL: https://test1.example.com/stripe-webhooks'))
    console.log(chalk.gray('   Expected: Should reuse existing webhook'))

    const result2 = await stripeSync.findOrCreateManagedWebhook(
      'https://test1.example.com/stripe-webhooks',
      {
        enabled_events: ['*'],
        description: 'stripe-sync-cli test webhook 1',
      }
    )
    const webhookId2 = result2.webhook.id
    const webhookUuid2 = result2.uuid

    if (webhookId2 === webhookId1 && webhookUuid2 === webhookUuid1) {
      console.log(chalk.green('   ✓ SUCCESS: Webhook was reused!'))
      console.log(chalk.cyan(`   - Same Webhook ID: ${webhookId2}`))
      console.log(chalk.cyan(`   - Same UUID: ${webhookUuid2}`))
    } else {
      console.log(chalk.red('   ❌ FAIL: New webhook was created instead of reusing'))
      console.log(chalk.yellow(`   - Original ID: ${webhookId1}, UUID: ${webhookUuid1}`))
      console.log(chalk.yellow(`   - New ID: ${webhookId2}, UUID: ${webhookUuid2}`))
      if (webhookId2 !== webhookId1) {
        createdWebhookIds.push(webhookId2)
      }
    }
    console.log()

    // Test 3: Call with different base URL (should create new)
    console.log(chalk.blue('📝 Test 3: Call with different base URL'))
    console.log(chalk.gray('   Base URL: https://test2.example.com/stripe-webhooks'))
    console.log(chalk.gray('   Expected: Should create new webhook'))

    const result3 = await stripeSync.findOrCreateManagedWebhook(
      'https://test2.example.com/stripe-webhooks',
      {
        enabled_events: ['*'],
        description: 'stripe-sync-cli test webhook 2',
      }
    )
    const webhookId3 = result3.webhook.id
    const webhookUuid3 = result3.uuid

    createdWebhookIds.push(webhookId3)

    if (webhookId3 !== webhookId1 && webhookUuid3 !== webhookUuid1) {
      console.log(chalk.green('   ✓ SUCCESS: New webhook was created!'))
      console.log(chalk.cyan(`   - New Webhook ID: ${webhookId3}`))
      console.log(chalk.cyan(`   - New UUID: ${webhookUuid3}`))
      console.log(chalk.cyan(`   - URL: ${result3.webhook.url}`))
    } else {
      console.log(chalk.red('   ❌ FAIL: Webhook was incorrectly reused'))
      console.log(chalk.yellow(`   - Should have created new webhook for different base URL`))
    }
    console.log()

    console.log(chalk.blue('====================================='))
    console.log(chalk.green('✅ Verification complete!'))
    console.log()

    // Cleanup: Delete all created webhooks
    console.log(chalk.blue('🧹 Cleaning up test webhooks...'))

    for (const webhookId of createdWebhookIds) {
      try {
        await stripeSync.deleteManagedWebhook(webhookId)
        console.log(chalk.gray(`   - Deleted webhook: ${webhookId}`))
      } catch (error) {
        console.log(chalk.yellow(`   - Failed to delete webhook ${webhookId}: ${error}`))
      }
    }

    console.log(chalk.green('✓ Cleanup complete\n'))
    process.exit(0)
  } catch (error) {
    console.error(chalk.red('\n❌ Error during verification:'))
    console.error(error)
    process.exit(1)
  }
}

main()
