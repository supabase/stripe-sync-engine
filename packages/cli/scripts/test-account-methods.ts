#!/usr/bin/env tsx

/**
 * Test helper script for account management methods.
 * NOT exposed as CLI commands - used only for integration testing.
 *
 * Supports:
 * - getCurrentAccount()
 * - getAllSyncedAccounts()
 * - dangerouslyDeleteSyncedAccountData()
 */

import dotenv from 'dotenv'
import { StripeSync } from 'stripe-experiment-sync'
import { PgAdapter } from 'stripe-experiment-sync/pg'

dotenv.config()

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.error('Usage: tsx scripts/test-account-methods.ts <method> [options]')
    console.error('')
    console.error('Methods:')
    console.error('  get-account              Get current account')
    console.error('  list-accounts            List all synced accounts')
    console.error('  delete-account <id>      Delete account (with options)')
    console.error('')
    console.error('Delete options:')
    console.error('  --dry-run                Preview deletion without executing')
    console.error('  --no-transaction         Disable transaction (for large datasets)')
    process.exit(1)
  }

  const method = args[0]
  const databaseUrl = process.env.DATABASE_URL || ''
  const stripeApiKey = process.env.STRIPE_API_KEY || ''

  if (!databaseUrl) {
    console.error('Error: DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const adapter = new PgAdapter({
    max: 10,
    connectionString: databaseUrl,
    keepAlive: true,
  })

  // Silent logger for tests (logs to stderr to not interfere with JSON output)
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  }

  try {
    if (method === 'get-account') {
      // Get current account
      if (!stripeApiKey) {
        console.error('Error: STRIPE_API_KEY environment variable is required for get-account')
        process.exit(1)
      }

      const stripeSync = new StripeSync({
        stripeSecretKey: stripeApiKey,
        stripeApiVersion: '2020-08-27',
        adapter,
        logger,
      })

      const account = await stripeSync.getCurrentAccount()
      console.log(JSON.stringify(account, null, 2))
    } else if (method === 'list-accounts') {
      // List all synced accounts
      const stripeSync = new StripeSync({
        stripeSecretKey: 'sk_test_placeholder', // Not needed for listing
        stripeApiVersion: '2020-08-27',
        adapter,
        logger,
      })

      const accounts = await stripeSync.getAllSyncedAccounts()
      console.log(JSON.stringify(accounts, null, 2))
    } else if (method === 'delete-account') {
      // Delete account
      if (args.length < 2) {
        console.error('Error: delete-account requires an account ID')
        console.error(
          'Usage: tsx scripts/test-account-methods.ts delete-account <accountId> [--dry-run] [--no-transaction]'
        )
        process.exit(1)
      }

      const accountId = args[1]
      const dryRun = args.includes('--dry-run')
      const useTransaction = !args.includes('--no-transaction')

      const stripeSync = new StripeSync({
        stripeSecretKey: 'sk_test_placeholder', // Not needed for deletion
        stripeApiVersion: '2020-08-27',
        adapter,
        logger,
      })

      const result = await stripeSync.dangerouslyDeleteSyncedAccountData(accountId, {
        dryRun,
        useTransaction,
      })

      console.log(JSON.stringify(result, null, 2))
    } else {
      console.error(`Error: Unknown method '${method}'`)
      console.error('Valid methods: get-account, list-accounts, delete-account')
      process.exit(1)
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : 'Unknown error')
    process.exit(1)
  }
}

main()
