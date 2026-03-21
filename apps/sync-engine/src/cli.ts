#!/usr/bin/env node

import 'dotenv/config'
import { Command } from 'commander'
import { syncAction } from './sync-command'
import { checkAction } from './check-command'

const program = new Command()

program
  .name('sync-engine')
  .description('Stripe Sync Engine — sync Stripe data to Postgres')
  .version('0.1.0')

function addOptions(cmd: Command): Command {
  return (
    cmd
      // Source (Stripe)
      .option('--stripe-api-key <key>', 'Stripe API key (or STRIPE_API_KEY env)')
      .option('--stripe-base-url <url>', 'Override Stripe API base URL')
      .option('--websocket', 'Stay alive for real-time WebSocket events')
      .option('--backfill-limit <n>', 'Max objects to backfill per stream', parseInt)
      // Destination (Postgres)
      .option(
        '--postgres-url <url>',
        'Postgres connection string (or POSTGRES_URL / DATABASE_URL env)'
      )
      .option('--postgres-schema <name>', 'Target schema (default: "stripe")')
      // Sync
      .option('--streams <names>', 'Comma-separated stream names to sync')
      .option('--no-state', 'Skip state loading/saving (always full refresh)')
      // Generic escape hatches
      .option('--source <name>', 'Source connector name (inferred from flags)')
      .option('--destination <name>', 'Destination connector name (inferred from flags)')
      .option('--source-config <json>', 'Raw source config JSON or @file')
      .option('--destination-config <json>', 'Raw destination config JSON or @file')
      .option('--config <file>', 'Config file with full SyncParams')
  )
}

// Default command: `sync-engine` with no subcommand runs sync
addOptions(program).action(async (opts) => {
  await syncAction(opts)
})

// Explicit `sync` subcommand — alias for default
addOptions(program.command('sync').description('Run sync pipeline (default command)')).action(
  async (opts) => {
    await syncAction(opts)
  }
)

// Check command
addOptions(
  program.command('check').description('Check source and destination connectivity')
).action(async (opts) => {
  await checkAction(opts)
})

program.parse()
