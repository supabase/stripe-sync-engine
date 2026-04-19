import { Readable } from 'node:stream'
import { defineCommand } from 'citty'
import { createCliFromSpec } from '@stripe/sync-ts-cli/openapi'
import { parseJsonOrFile } from '@stripe/sync-ts-cli'
import { createConnectorResolver, createEngine } from '../lib/index.js'
import type { ConnectorResolver } from '../lib/index.js'
import { createApp } from '../api/app.js'
import { startApiServer } from '../api/server.js'
import { supabaseCmd } from './supabase.js'
import { createSyncCmd } from './sync.js'
import { defaultConnectors } from '../lib/default-connectors.js'

/** Connector discovery flags shared by all commands (serve + one-shot). */
const connectorArgs = {
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
    description: 'Enable npm auto-download of connectors (disabled by default)',
  },
}

/**
 * Pre-parse connector discovery flags from process.argv so the resolver
 * is configured before the one-shot CLI commands (check, read, etc.) run.
 */
function parseConnectorFlags(): {
  connectorsFromPath: boolean
  connectorsFromNpm: boolean
  connectorsFromCommandMap?: string
} {
  const argv = process.argv
  const noPath = argv.includes('--no-connectors-from-path')
  const npm = argv.includes('--connectors-from-npm')
  let commandMap: string | undefined
  const cmdMapIdx = argv.indexOf('--connectors-from-command-map')
  if (cmdMapIdx !== -1 && cmdMapIdx + 1 < argv.length) {
    commandMap = argv[cmdMapIdx + 1]
  }
  return {
    connectorsFromPath: !noPath,
    connectorsFromNpm: npm,
    connectorsFromCommandMap: commandMap,
  }
}

function createServeCmd(resolver: ConnectorResolver) {
  return defineCommand({
    meta: { name: 'serve', description: 'Start the HTTP API server' },
    args: {
      port: { type: 'string', description: 'Port to listen on (or PORT env)' },
      ...connectorArgs,
    },
    async run({ args }) {
      await startApiServer({
        resolver,
        port: args.port ? parseInt(args.port) : undefined,
      })
    },
  })
}

export async function createProgram() {
  const flags = parseConnectorFlags()
  const resolver = await createConnectorResolver(defaultConnectors, {
    path: flags.connectorsFromPath,
    npm: flags.connectorsFromNpm,
    commandMap: parseJsonOrFile(flags.connectorsFromCommandMap) as
      | Record<string, string>
      | undefined,
  })
  const engine = await createEngine(resolver)
  const app = await createApp(resolver)
  const res = await app.request('/openapi.json')
  const spec = await res.json()

  const specCli = createCliFromSpec({
    spec,
    handler: async (req) => app.fetch(req),
    exclude: ['health'],
    ndjsonBodyStream: () =>
      process.stdin.isTTY ? null : (Readable.toWeb(process.stdin) as ReadableStream),
    rootArgs: connectorArgs,
    meta: {
      name: 'sync-engine',
      description: 'Stripe Sync Engine — sync Stripe data to Postgres',
      version: '0.1.0',
    },
  })

  const serveCmd = createServeCmd(resolver)

  return defineCommand({
    ...specCli,
    subCommands: {
      serve: serveCmd,
      supabase: supabaseCmd,
      sync: createSyncCmd(engine, resolver),
      ...specCli.subCommands,
    },
  })
}
