#!/usr/bin/env tsx

import 'dotenv/config'
import { defineCommand, runMain } from 'citty'
import { syncAction } from '../sync-command.js'
import { checkAction } from '../check-command.js'
import { serveAction } from '../serve-command.js'

function addArgs() {
  return {
    // Source (Stripe)
    stripeApiKey: {
      type: 'string' as const,
      description: 'Stripe API key (or STRIPE_API_KEY env)',
    },
    stripeBaseUrl: { type: 'string' as const, description: 'Override Stripe API base URL' },
    websocket: {
      type: 'boolean' as const,
      default: false,
      description: 'Stay alive for real-time WebSocket events',
    },
    backfillLimit: { type: 'string' as const, description: 'Max objects to backfill per stream' },
    // Destination (Postgres)
    postgresUrl: {
      type: 'string' as const,
      description: 'Postgres connection string (or POSTGRES_URL / DATABASE_URL env)',
    },
    postgresSchema: { type: 'string' as const, description: 'Target schema (default: "stripe")' },
    // Sync
    streams: { type: 'string' as const, description: 'Comma-separated stream names to sync' },
    noState: {
      type: 'boolean' as const,
      default: false,
      description: 'Skip state loading/saving (always full refresh)',
    },
    // Generic escape hatches
    source: { type: 'string' as const, description: 'Source connector name (inferred from flags)' },
    destination: {
      type: 'string' as const,
      description: 'Destination connector name (inferred from flags)',
    },
    sourceConfig: { type: 'string' as const, description: 'Raw source config JSON or @file' },
    destinationConfig: {
      type: 'string' as const,
      description: 'Raw destination config JSON or @file',
    },
    config: { type: 'string' as const, description: 'Config file with full SyncParams' },
    // Connector discovery
    connectorsFromCommandMap: {
      type: 'string' as const,
      description: 'Explicit connector command mappings (JSON object or @file)',
    },
    noConnectorsFromPath: {
      type: 'boolean' as const,
      default: false,
      description: 'Disable PATH-based connector discovery',
    },
    connectorsFromNpm: {
      type: 'boolean' as const,
      default: false,
      description: 'Enable npm auto-download of connectors',
    },
  }
}

// Serve command — HTTP API server
const serveCmd = defineCommand({
  meta: { name: 'serve', description: 'Start the HTTP API server' },
  args: {
    port: { type: 'string', description: 'Port to listen on (or PORT env)' },
    connectorsFromCommandMap: {
      type: 'string',
      description: 'Explicit connector command mappings (JSON object or @file)',
    },
    noConnectorsFromPath: {
      type: 'boolean',
      default: false,
      description: 'Disable PATH-based connector discovery',
    },
    connectorsFromNpm: {
      type: 'boolean',
      default: false,
      description: 'Enable npm auto-download of connectors (disabled by default)',
    },
  },
  async run({ args }) {
    serveAction({
      port: args.port ? parseInt(args.port) : undefined,
      connectorsFromCommandMap: args.connectorsFromCommandMap,
      connectorsFromPath: !args.noConnectorsFromPath,
      connectorsFromNpm: args.connectorsFromNpm,
    })
  },
})

// Sync command
const syncCmd = defineCommand({
  meta: { name: 'sync', description: 'Run sync pipeline' },
  args: addArgs(),
  async run({ args }) {
    await syncAction({
      ...args,
      backfillLimit: args.backfillLimit ? parseInt(args.backfillLimit) : undefined,
    })
  },
})

// Check command
const checkCmd = defineCommand({
  meta: { name: 'check', description: 'Check source and destination connectivity' },
  args: addArgs(),
  async run({ args }) {
    await checkAction({
      ...args,
      backfillLimit: args.backfillLimit ? parseInt(args.backfillLimit) : undefined,
    })
  },
})

const program = defineCommand({
  meta: {
    name: 'sync-engine',
    description: 'Stripe Sync Engine — sync Stripe data to Postgres',
    version: '0.1.0',
  },
  args: {
    port: { type: 'string', description: 'Port to listen on (or PORT env)' },
    connectorsFromCommandMap: {
      type: 'string',
      description: 'Explicit connector command mappings (JSON object or @file)',
    },
    noConnectorsFromPath: {
      type: 'boolean',
      default: false,
      description: 'Disable PATH-based connector discovery',
    },
    connectorsFromNpm: {
      type: 'boolean',
      default: false,
      description: 'Enable npm auto-download of connectors',
    },
  },
  subCommands: { serve: serveCmd, sync: syncCmd, check: checkCmd },
  async run({ args }) {
    // Default action: start HTTP API server
    serveAction({
      port: args.port ? parseInt(args.port) : undefined,
      connectorsFromCommandMap: args.connectorsFromCommandMap,
      connectorsFromPath: !args.noConnectorsFromPath,
      connectorsFromNpm: args.connectorsFromNpm,
    })
  },
})

runMain(program)
