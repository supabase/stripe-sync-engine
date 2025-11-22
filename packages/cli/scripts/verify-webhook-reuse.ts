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
  let hasFailures = false

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

    const webhook1 = await stripeSync.findOrCreateManagedWebhook(
      'https://test1.example.com/stripe-webhooks',
      {
        enabled_events: ['*'],
      }
    )
    const webhookId1 = webhook1.id

    createdWebhookIds.push(webhookId1)

    console.log(chalk.green('   ✓ Webhook created'))
    console.log(chalk.cyan(`   - Webhook ID: ${webhookId1}`))
    console.log(chalk.cyan(`   - URL: ${webhook1.url}`))

    // Verify webhook count
    const webhooks1 = await stripeSync['listManagedWebhooks']()
    if (webhooks1.length === 1) {
      console.log(chalk.green(`   ✓ Webhook count: ${webhooks1.length} (expected: 1)`))
    } else {
      hasFailures = true
      console.log(chalk.red(`   ❌ FAIL: Expected 1 webhook, found ${webhooks1.length}`))
    }
    console.log()

    // Test 2: Call findOrCreateManagedWebhook again with same base URL (should reuse)
    console.log(chalk.blue('📝 Test 2: Retry with same base URL'))
    console.log(chalk.gray('   Base URL: https://test1.example.com/stripe-webhooks'))
    console.log(chalk.gray('   Expected: Should reuse existing webhook'))

    const webhook2 = await stripeSync.findOrCreateManagedWebhook(
      'https://test1.example.com/stripe-webhooks',
      {
        enabled_events: ['*'],
      }
    )
    const webhookId2 = webhook2.id

    if (webhookId2 === webhookId1) {
      console.log(chalk.green('   ✓ SUCCESS: Webhook was reused!'))
      console.log(chalk.cyan(`   - Same Webhook ID: ${webhookId2}`))
    } else {
      hasFailures = true
      console.log(chalk.red('   ❌ FAIL: New webhook was created instead of reusing'))
      console.log(chalk.yellow(`   - Original ID: ${webhookId1}`))
      console.log(chalk.yellow(`   - New ID: ${webhookId2}`))
      if (webhookId2 !== webhookId1) {
        createdWebhookIds.push(webhookId2)
      }
    }

    // Verify webhook count (should still be 1 - reused)
    const webhooks2 = await stripeSync['listManagedWebhooks']()
    if (webhooks2.length === 1) {
      console.log(chalk.green(`   ✓ Webhook count: ${webhooks2.length} (expected: 1, reused)`))
    } else {
      hasFailures = true
      console.log(chalk.red(`   ❌ FAIL: Expected 1 webhook, found ${webhooks2.length}`))
    }
    console.log()

    // Test 3: Call with different base URL (should create new)
    console.log(chalk.blue('📝 Test 3: Call with different base URL'))
    console.log(chalk.gray('   Base URL: https://test2.example.com/stripe-webhooks'))
    console.log(chalk.gray('   Expected: Should create new webhook'))

    const webhook3 = await stripeSync.findOrCreateManagedWebhook(
      'https://test2.example.com/stripe-webhooks',
      {
        enabled_events: ['*'],
      }
    )
    const webhookId3 = webhook3.id

    createdWebhookIds.push(webhookId3)

    if (webhookId3 !== webhookId1) {
      console.log(chalk.green('   ✓ SUCCESS: New webhook was created!'))
      console.log(chalk.cyan(`   - New Webhook ID: ${webhookId3}`))
      console.log(chalk.cyan(`   - URL: ${webhook3.url}`))
    } else {
      hasFailures = true
      console.log(chalk.red('   ❌ FAIL: Webhook was incorrectly reused'))
      console.log(chalk.yellow(`   - Should have created new webhook for different base URL`))
    }
    console.log()

    // Test 4: Simulate orphaned webhook scenario (webhook in Stripe but not in DB)
    console.log(chalk.blue('📝 Test 4: Orphaned webhook cleanup'))
    console.log(chalk.gray('   Simulating scenario: webhook exists in Stripe but not in database'))
    console.log(chalk.gray('   Expected: Should delete orphaned webhook and create new one'))

    // First, create a webhook and remember its ID
    const webhook4a = await stripeSync.findOrCreateManagedWebhook(
      'https://test3.example.com/stripe-webhooks',
      {
        enabled_events: ['*'],
      }
    )
    const orphanedWebhookId = webhook4a.id
    createdWebhookIds.push(orphanedWebhookId)

    console.log(chalk.gray(`   - Created webhook: ${orphanedWebhookId}`))

    // Now delete it from the database only (simulating orphaned state)
    await stripeSync['postgresClient'].query(
      `DELETE FROM "stripe"."_managed_webhooks" WHERE id = $1`,
      [orphanedWebhookId]
    )
    console.log(chalk.gray(`   - Deleted from database (webhook still exists in Stripe)`))

    // Now call findOrCreateManagedWebhook again - it should clean up the orphan and create new one
    const webhook4b = await stripeSync.findOrCreateManagedWebhook(
      'https://test3.example.com/stripe-webhooks',
      {
        enabled_events: ['*'],
      }
    )
    const newWebhookId = webhook4b.id

    if (newWebhookId !== orphanedWebhookId) {
      console.log(
        chalk.green('   ✓ SUCCESS: Orphaned webhook was cleaned up and new webhook created!')
      )
      console.log(chalk.cyan(`   - Old (orphaned) Webhook ID: ${orphanedWebhookId}`))
      console.log(chalk.cyan(`   - New Webhook ID: ${newWebhookId}`))
      createdWebhookIds.push(newWebhookId)

      // Verify the orphaned webhook was actually deleted from Stripe
      try {
        await stripeSync['stripe'].webhookEndpoints.retrieve(orphanedWebhookId)
        hasFailures = true
        console.log(chalk.red('   ❌ FAIL: Orphaned webhook still exists in Stripe'))
      } catch (error) {
        console.log(chalk.green('   ✓ Confirmed: Orphaned webhook was deleted from Stripe'))
      }
    } else {
      hasFailures = true
      console.log(
        chalk.red('   ❌ FAIL: Same webhook was reused (orphaned webhook not cleaned up)')
      )
    }
    console.log()

    // Test 5: Backwards compatibility - orphaned webhook with old description format
    console.log(chalk.blue('📝 Test 5: Backwards compatibility with old description formats'))
    console.log(chalk.gray('   Testing cleanup of webhooks with old description formats'))
    console.log(
      chalk.gray('   Expected: Should delete orphaned webhooks with various description formats')
    )

    // Create webhooks with different old description formats directly via Stripe API
    const oldDescriptions = [
      'stripe-sync-cli development webhook',
      'Stripe Sync Development',
      'stripe  sync', // extra spaces
    ]

    const oldWebhookIds: string[] = []
    for (let i = 0; i < oldDescriptions.length; i++) {
      const desc = oldDescriptions[i]
      const oldWebhook = await stripeSync['stripe'].webhookEndpoints.create({
        url: `https://test4.example.com/stripe-webhooks/old-webhook-${i}`,
        enabled_events: ['*'],
        description: desc,
      })
      oldWebhookIds.push(oldWebhook.id)
      createdWebhookIds.push(oldWebhook.id)
      console.log(
        chalk.gray(`   - Created old-format webhook: ${oldWebhook.id} (description: "${desc}")`)
      )
    }

    // Now call findOrCreateManagedWebhook - it should clean up all old webhooks
    const webhook5 = await stripeSync.findOrCreateManagedWebhook(
      'https://test4.example.com/stripe-webhooks',
      {
        enabled_events: ['*'],
      }
    )
    const newWebhookId5 = webhook5.id
    createdWebhookIds.push(newWebhookId5)

    // Verify all old webhooks were deleted
    let allDeleted = true
    for (const oldId of oldWebhookIds) {
      try {
        await stripeSync['stripe'].webhookEndpoints.retrieve(oldId)
        allDeleted = false
        console.log(chalk.red(`   ❌ Old webhook ${oldId} still exists`))
      } catch (error) {
        // Expected - webhook was deleted
      }
    }

    if (allDeleted) {
      console.log(chalk.green('   ✓ SUCCESS: All old-format webhooks were cleaned up!'))
      console.log(chalk.cyan(`   - New Webhook ID: ${newWebhookId5}`))
      console.log(chalk.cyan(`   - New Webhook Description: "${webhook5.description}"`))
    } else {
      hasFailures = true
      console.log(chalk.red('   ❌ FAIL: Some old-format webhooks were not cleaned up'))
    }
    console.log()

    // Test 6: URL mismatch cleanup - Webhook with different URL should be deleted
    console.log(chalk.blue('📝 Test 6: URL Mismatch Cleanup (UUID Migration)'))
    console.log(chalk.gray('   Testing automatic cleanup of webhooks with mismatched URLs'))
    console.log(chalk.gray('   Expected: Should delete mismatched webhook and create new one'))

    // Manually create a webhook with UUID in URL (simulating legacy webhook)
    const legacyUuid = 'legacy-uuid-12345'
    const legacyWebhook = await stripeSync['stripe'].webhookEndpoints.create({
      url: `https://test5.example.com/stripe-webhooks/${legacyUuid}`,
      enabled_events: ['*'],
      metadata: {
        managed_by: 'stripe-sync',
      },
    })
    const legacyWebhookId = legacyWebhook.id
    createdWebhookIds.push(legacyWebhookId)

    console.log(chalk.gray(`   - Created legacy webhook: ${legacyWebhookId}`))
    console.log(chalk.gray(`   - Legacy URL with UUID: ${legacyWebhook.url}`))

    // Insert into database using upsertManagedWebhooks to simulate legacy state
    const accountId = await stripeSync['getAccountId']()
    await stripeSync['upsertManagedWebhooks']([legacyWebhook], accountId)
    console.log(chalk.gray(`   - Inserted into database`))

    // Now call findOrCreateManagedWebhook with base URL - should detect URL mismatch, delete, and recreate
    const newWebhook6 = await stripeSync.findOrCreateManagedWebhook(
      'https://test5.example.com/stripe-webhooks',
      {
        enabled_events: ['*'],
      }
    )
    const newWebhookId6 = newWebhook6.id

    if (newWebhookId6 !== legacyWebhookId) {
      console.log(chalk.green('   ✓ SUCCESS: Legacy webhook with UUID was cleaned up!'))
      console.log(chalk.cyan(`   - Old Webhook ID: ${legacyWebhookId}`))
      console.log(chalk.cyan(`   - New Webhook ID: ${newWebhookId6}`))
      console.log(chalk.cyan(`   - Old URL: ${legacyWebhook.url}`))
      console.log(chalk.cyan(`   - New URL: ${newWebhook6.url}`))
      createdWebhookIds.push(newWebhookId6)

      // Verify old webhook was deleted from Stripe
      try {
        await stripeSync['stripe'].webhookEndpoints.retrieve(legacyWebhookId)
        hasFailures = true
        console.log(chalk.red('   ❌ FAIL: Legacy webhook still exists in Stripe'))
      } catch (error) {
        console.log(chalk.green('   ✓ Confirmed: Legacy webhook was deleted from Stripe'))
      }

      // Verify new webhook URL does not contain UUID
      if (
        !newWebhook6.url.includes(legacyUuid) &&
        newWebhook6.url === 'https://test5.example.com/stripe-webhooks'
      ) {
        console.log(chalk.green('   ✓ Confirmed: New webhook URL has no UUID'))
      } else {
        hasFailures = true
        console.log(chalk.red('   ❌ FAIL: New webhook URL still contains UUID or is incorrect'))
      }
    } else {
      hasFailures = true
      console.log(chalk.red('   ❌ FAIL: Legacy webhook was reused instead of being cleaned up'))
    }
    console.log()

    // Test 7: Multi-Account Webhook Isolation
    console.log(chalk.blue('📝 Test 7: Multi-Account Webhook Isolation'))
    console.log(chalk.gray('   Testing that webhooks are isolated per account'))
    console.log(
      chalk.gray('   Expected: listManagedWebhooks() only returns current account webhooks')
    )

    // Get current account ID
    const currentAccountId = await stripeSync['getAccountId']()
    console.log(chalk.gray(`   - Current account: ${currentAccountId}`))

    // Clean up any leftover fake webhook from previous test runs
    const fakeWebhookId = 'we_fake_different_account'
    await stripeSync['postgresClient'].query(
      `DELETE FROM "stripe"."_managed_webhooks" WHERE id = $1`,
      [fakeWebhookId]
    )

    // Create a webhook for current account
    const webhook7 = await stripeSync.findOrCreateManagedWebhook(
      'https://test7.example.com/stripe-webhooks',
      {
        enabled_events: ['*'],
      }
    )
    createdWebhookIds.push(webhook7.id)

    // Manually insert a webhook with a different account_id
    // We'll use the current account ID as base and modify it slightly to create a different but valid-looking ID
    const differentAccountId = currentAccountId + '_different'

    // First, insert a fake account to satisfy the foreign key constraint
    // Note: id is a generated column, so we only need to insert _raw_data
    await stripeSync['postgresClient'].query(
      `INSERT INTO "stripe"."accounts" ("_raw_data", "first_synced_at", "_last_synced_at")
       VALUES ($1, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify({ id: differentAccountId, type: 'test_account' })]
    )

    // Now insert the webhook with the different account_id
    await stripeSync['postgresClient'].query(
      `INSERT INTO "stripe"."_managed_webhooks"
       (id, url, enabled_events, secret, status, created, account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        fakeWebhookId,
        'https://test7-different.example.com/stripe-webhooks',
        JSON.stringify(['*']),
        'whsec_fake_secret',
        'enabled',
        Math.floor(Date.now() / 1000),
        differentAccountId,
      ]
    )

    console.log(
      chalk.gray(`   - Inserted fake webhook with different account_id: ${differentAccountId}`)
    )

    // List webhooks - should only see current account's webhook
    const webhooks7 = await stripeSync['listManagedWebhooks']()

    if (webhooks7.length === 1) {
      console.log(
        chalk.green(
          `   ✓ SUCCESS: listManagedWebhooks() returned 1 webhook (correct account filtering)`
        )
      )
      if ((webhooks7[0] as any).account_id === currentAccountId) {
        console.log(chalk.green(`   ✓ Confirmed: Returned webhook has correct account_id`))
      } else {
        hasFailures = true
        console.log(
          chalk.red(`   ❌ FAIL: Webhook has wrong account_id: ${(webhooks7[0] as any).account_id}`)
        )
      }
    } else {
      hasFailures = true
      console.log(
        chalk.red(
          `   ❌ FAIL: Expected 1 webhook, found ${webhooks7.length} (account filtering not working)`
        )
      )
    }

    // Cleanup fake webhook and fake account
    await stripeSync['postgresClient'].query(
      `DELETE FROM "stripe"."_managed_webhooks" WHERE id = $1`,
      [fakeWebhookId]
    )

    await stripeSync['postgresClient'].query(`DELETE FROM "stripe"."accounts" WHERE id = $1`, [
      differentAccountId,
    ])

    console.log(chalk.gray(`   - Cleaned up fake webhook and fake account`))
    console.log()

    // Test 8: Concurrent Execution (Race Condition Test)
    console.log(chalk.blue('📝 Test 8: Concurrent Execution (Race Condition)'))
    console.log(chalk.gray('   Testing that concurrent calls do not create duplicate webhooks'))
    console.log(chalk.gray('   Expected: All concurrent calls return the same webhook'))

    const concurrentUrl = 'https://test8-concurrent.example.com/stripe-webhooks'

    // Create 5 promises that will execute truly in parallel
    const concurrentPromises = Array(5)
      .fill(null)
      .map(() =>
        stripeSync.findOrCreateManagedWebhook(concurrentUrl, {
          enabled_events: ['*'],
        })
      )

    // Wait for all to complete
    const webhookResults = await Promise.all(concurrentPromises)

    // All should have the same ID
    const uniqueIds = new Set(webhookResults.map((w) => w.id))

    if (uniqueIds.size === 1) {
      console.log(chalk.green('   ✓ SUCCESS: All 5 concurrent calls returned same webhook!'))
      console.log(chalk.cyan(`   - Webhook ID: ${webhookResults[0].id}`))

      // Verify only one webhook exists in database
      const allWebhooks = await stripeSync['listManagedWebhooks']()
      const matchingWebhooks = allWebhooks.filter((w: any) => w.url === concurrentUrl)

      if (matchingWebhooks.length === 1) {
        console.log(chalk.green('   ✓ Confirmed: Only 1 webhook in database'))
      } else {
        hasFailures = true
        console.log(
          chalk.red(
            `   ❌ FAIL: Found ${matchingWebhooks.length} webhooks in database (expected 1)`
          )
        )
      }

      // Verify only one webhook exists in Stripe
      const stripeWebhooks = await stripeSync['stripe'].webhookEndpoints.list({ limit: 100 })
      const matchingStripeWebhooks = stripeWebhooks.data.filter(
        (w: any) => w.url === concurrentUrl && w.metadata?.managed_by === 'stripe-sync'
      )

      if (matchingStripeWebhooks.length === 1) {
        console.log(chalk.green('   ✓ Confirmed: Only 1 webhook in Stripe'))
      } else {
        hasFailures = true
        console.log(
          chalk.red(
            `   ❌ FAIL: Found ${matchingStripeWebhooks.length} webhooks in Stripe (expected 1)`
          )
        )
      }

      createdWebhookIds.push(webhookResults[0].id)
    } else {
      hasFailures = true
      console.log(
        chalk.red(
          `   ❌ FAIL: Concurrent calls created ${uniqueIds.size} different webhooks (expected 1)`
        )
      )
      console.log(chalk.yellow(`   - Unique webhook IDs: ${Array.from(uniqueIds).join(', ')}`))
      // Add all unique IDs for cleanup
      uniqueIds.forEach((id) => createdWebhookIds.push(id))
    }
    console.log()

    console.log(chalk.blue('====================================='))

    if (hasFailures) {
      console.log(chalk.red('❌ Verification failed - some tests did not pass'))
    } else {
      console.log(chalk.green('✅ Verification complete - all tests passed!'))
    }
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

    if (hasFailures) {
      process.exit(1)
    } else {
      process.exit(0)
    }
  } catch (error) {
    console.error(chalk.red('\n❌ Error during verification:'))
    console.error(error)
    process.exit(1)
  }
}

main()
