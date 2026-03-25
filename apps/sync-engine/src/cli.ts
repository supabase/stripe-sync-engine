#!/usr/bin/env tsx

import 'dotenv/config'
import { Command } from 'commander'
import { syncAction } from './sync-command.js'
import { checkAction } from './check-command.js'
import { serveAction } from './serve-command.js'

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
      // Connector discovery
      .option(
        '--connectors-from-command-map <json>',
        'Explicit connector command mappings (JSON object or @file)'
      )
      .option('--no-connectors-from-path', 'Disable PATH-based connector discovery')
      .option('--connectors-from-npm', 'Enable npm auto-download of connectors')
  )
}

// Serve command — HTTP API server (default when no subcommand)
program
  .command('serve', { isDefault: true })
  .description('Start the HTTP API server (default command)')
  .option('-p, --port <port>', 'Port to listen on (or PORT env)', parseInt)
  .option(
    '--connectors-from-command-map <json>',
    'Explicit connector command mappings (JSON object or @file)'
  )
  .option('--no-connectors-from-path', 'Disable PATH-based connector discovery')
  .option('--connectors-from-npm', 'Enable npm auto-download of connectors (disabled by default)')
  .action(async (opts) => {
    serveAction(opts)
  })

// Sync command
addOptions(program.command('sync').description('Run sync pipeline')).action(async (opts) => {
  await syncAction(opts)
})

// Check command
addOptions(
  program.command('check').description('Check source and destination connectivity')
).action(async (opts) => {
  await checkAction(opts)
})

program.parse()
