#!/usr/bin/env node

import { Command } from 'commander'
import { syncCommand } from './command'

const program = new Command()

program
  .name('stripe-sync')
  .description('CLI tool for syncing Stripe data to PostgreSQL')
  .version('0.0.0')
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

  

program.parse()
