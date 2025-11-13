#!/usr/bin/env tsx

/**
 * Manual verification script for webhook reuse functionality.
 * Tests that findOrCreateManagedWebhook correctly reuses existing webhooks
 * when the base URL matches, and creates new ones when it doesn't.
 */

import { StripeAutoSync } from 'stripe-experiment-sync'
import express from 'express'
import dotenv from 'dotenv'
import chalk from 'chalk'

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

  // Create Express app (required by StripeAutoSync.start())
  const app = express()

  const createdWebhookIds: string[] = []
  let stripeAutoSync: StripeAutoSync | null = null

  try {
    // Test 1: Create initial webhook with first base URL
    console.log(chalk.blue('📝 Test 1: Create initial webhook'))
    console.log(chalk.gray('   Base URL: https://test1.example.com/stripe-webhooks'))

    stripeAutoSync = new StripeAutoSync({
      databaseUrl: DATABASE_URL!,
      stripeApiKey: STRIPE_API_KEY!,
      baseUrl: () => 'https://test1.example.com',
      schema: 'stripe',
      keepWebhooksOnShutdown: true,
    })

    const result1 = await stripeAutoSync.start(app)
    const webhookId1 = (stripeAutoSync as any).webhookId
    const webhookUuid1 = result1.webhookUuid

    createdWebhookIds.push(webhookId1)

    console.log(chalk.green('   ✓ Webhook created'))
    console.log(chalk.cyan(`   - Webhook ID: ${webhookId1}`))
    console.log(chalk.cyan(`   - UUID: ${webhookUuid1}`))
    console.log(chalk.cyan(`   - URL: ${result1.webhookUrl}`))
    console.log()

    // Stop the first instance (but keep webhook in DB)
    await stripeAutoSync.stop()

    // Test 2: Start again with same base URL (should reuse)
    console.log(chalk.blue('📝 Test 2: Restart with same base URL'))
    console.log(chalk.gray('   Base URL: https://test1.example.com/stripe-webhooks'))
    console.log(chalk.gray('   Expected: Should reuse existing webhook'))

    stripeAutoSync = new StripeAutoSync({
      databaseUrl: DATABASE_URL!,
      stripeApiKey: STRIPE_API_KEY!,
      baseUrl: () => 'https://test1.example.com',
      schema: 'stripe',
      keepWebhooksOnShutdown: true,
    })

    const result2 = await stripeAutoSync.start(app)
    const webhookId2 = (stripeAutoSync as any).webhookId
    const webhookUuid2 = result2.webhookUuid

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

    // Stop the second instance
    await stripeAutoSync.stop()

    // Test 3: Start with different base URL (should create new)
    console.log(chalk.blue('📝 Test 3: Start with different base URL'))
    console.log(chalk.gray('   Base URL: https://test2.example.com/stripe-webhooks'))
    console.log(chalk.gray('   Expected: Should create new webhook'))

    stripeAutoSync = new StripeAutoSync({
      databaseUrl: DATABASE_URL!,
      stripeApiKey: STRIPE_API_KEY!,
      baseUrl: () => 'https://test2.example.com',
      schema: 'stripe',
      keepWebhooksOnShutdown: true,
    })

    const result3 = await stripeAutoSync.start(app)
    const webhookId3 = (stripeAutoSync as any).webhookId
    const webhookUuid3 = result3.webhookUuid

    createdWebhookIds.push(webhookId3)

    if (webhookId3 !== webhookId1 && webhookUuid3 !== webhookUuid1) {
      console.log(chalk.green('   ✓ SUCCESS: New webhook was created!'))
      console.log(chalk.cyan(`   - New Webhook ID: ${webhookId3}`))
      console.log(chalk.cyan(`   - New UUID: ${webhookUuid3}`))
      console.log(chalk.cyan(`   - URL: ${result3.webhookUrl}`))
    } else {
      console.log(chalk.red('   ❌ FAIL: Webhook was incorrectly reused'))
      console.log(chalk.yellow(`   - Should have created new webhook for different base URL`))
    }
    console.log()

    await stripeAutoSync.stop()

    console.log(chalk.blue('====================================='))
    console.log(chalk.green('✅ Verification complete!'))
    console.log()

  } catch (error) {
    console.error(chalk.red('\n❌ Error during verification:'))
    console.error(error)
  } finally {
    // Cleanup: Delete all created webhooks
    console.log(chalk.blue('🧹 Cleaning up test webhooks...'))

    // Create a temporary StripeAutoSync just to access the delete method
    if (createdWebhookIds.length > 0 && STRIPE_API_KEY && DATABASE_URL) {
      const cleanupSync = new StripeAutoSync({
        databaseUrl: DATABASE_URL!,
        stripeApiKey: STRIPE_API_KEY!,
        baseUrl: () => 'https://cleanup.example.com',
        schema: 'stripe',
      })

      // Initialize it with a fake app to get stripeSync instance
      const cleanupApp = express()
      await cleanupSync.start(cleanupApp)

      const stripeSync = (cleanupSync as any).stripeSync

      for (const webhookId of createdWebhookIds) {
        try {
          await stripeSync.deleteManagedWebhook(webhookId)
          console.log(chalk.gray(`   - Deleted webhook: ${webhookId}`))
        } catch (error) {
          console.log(chalk.yellow(`   - Failed to delete webhook ${webhookId}: ${error}`))
        }
      }
    }

    console.log(chalk.green('✓ Cleanup complete\n'))
    process.exit(0)
  }
}

main()
