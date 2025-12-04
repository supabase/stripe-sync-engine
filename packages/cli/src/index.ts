#!/usr/bin/env node

import { Command } from 'commander'
import { syncCommand, migrateCommand, backfillCommand, deployCommand } from './command'

const program = new Command()

program
  .name('stripe-sync')
  .description('CLI tool for syncing Stripe data to PostgreSQL')
  .version('0.0.0')

// Migrate command
program
  .command('migrate')
  .description('Run database migrations only')
  .option('--database-url <url>', 'Postgres DATABASE_URL (or DATABASE_URL env)')
  .action(async (options) => {
    await migrateCommand({
      databaseUrl: options.databaseUrl,
    })
  })

// Start command (main sync command)
program
  .command('start')
  .description('Start Stripe sync')
  .option('--stripe-key <key>', 'Stripe API key (or STRIPE_API_KEY env)')
  .option('--ngrok-token <token>', 'ngrok auth token (or NGROK_AUTH_TOKEN env)')
  .option('--database-url <url>', 'Postgres DATABASE_URL (or DATABASE_URL env)')
  .action(async (options) => {
    await syncCommand({
      stripeKey: options.stripeKey,
      ngrokToken: options.ngrokToken,
      databaseUrl: options.databaseUrl,
    })
  })

// Backfill command
program
  .command('backfill <entityName>')
  .description('Backfill a specific entity type from Stripe (e.g., customer, invoice, product)')
  .option('--stripe-key <key>', 'Stripe API key (or STRIPE_API_KEY env)')
  .option('--database-url <url>', 'Postgres DATABASE_URL (or DATABASE_URL env)')
  .action(async (entityName, options) => {
    await backfillCommand(
      {
        stripeKey: options.stripeKey,
        databaseUrl: options.databaseUrl,
      },
      entityName
    )
  })

// Deploy command (Supabase Edge Functions)
program
  .command('deploy')
  .description('Deploy Stripe sync to Supabase Edge Functions')
  .option('--token <token>', 'Supabase access token (or SUPABASE_ACCESS_TOKEN env)')
  .option('--project <ref>', 'Supabase project ref (or SUPABASE_PROJECT_REF env)')
  .option('--stripe-key <key>', 'Stripe API key (or STRIPE_API_KEY env)')
  .action(async (options) => {
    await deployCommand({
      supabaseAccessToken: options.token,
      supabaseProjectRef: options.project,
      stripeKey: options.stripeKey,
    })
  })

program.parse()
