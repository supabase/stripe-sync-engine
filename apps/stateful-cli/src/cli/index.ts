#!/usr/bin/env node

import 'dotenv/config'
import { Command } from 'commander'
import { runSync } from './run'

const program = new Command()

program
  .name('sync-engine-stateful')
  .description('Stripe Sync Engine — stateful sync with credential and state management')
  .version('0.1.0')

program
  .command('run')
  .description('Run a sync using environment credentials (STRIPE_API_KEY, DATABASE_URL)')
  .option('--sync-id <id>', 'Sync ID', 'cli_sync')
  .option('--source-type <type>', 'Source connector type', 'stripe')
  .option('--destination-type <type>', 'Destination connector type', 'postgres')
  .action(async (opts) => {
    for await (const msg of runSync({
      syncId: opts.syncId,
      sourceType: opts.sourceType,
      destinationType: opts.destinationType,
    })) {
      process.stdout.write(JSON.stringify(msg) + '\n')
    }
  })

program.parse()
