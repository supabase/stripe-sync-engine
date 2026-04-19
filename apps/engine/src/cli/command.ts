import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { defineCommand } from 'citty'
import { createCliFromSpec } from '@stripe/sync-ts-cli/openapi'
import { parseJsonOrFile } from '@stripe/sync-ts-cli'
import { createConnectorResolver } from '../lib/index.js'
import { startApiServer } from '../api/server.js'
import { supabaseCmd } from './supabase.js'
import { createSyncCmd } from './sync.js'
import { defaultConnectors } from '../lib/default-connectors.js'
import { spawnServeSubprocess, type ServeSubprocess } from './subprocess.js'

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

function createServeCmd() {
  return defineCommand({
    meta: { name: 'serve', description: 'Start the HTTP API server' },
    args: {
      port: { type: 'string', description: 'Port to listen on (or PORT env)' },
      ...connectorArgs,
    },
    async run({ args }) {
      const flags = parseConnectorFlags()
      const resolver = await createConnectorResolver(defaultConnectors, {
        path: flags.connectorsFromPath,
        npm: flags.connectorsFromNpm,
        commandMap: parseJsonOrFile(flags.connectorsFromCommandMap) as
          | Record<string, string>
          | undefined,
      })
      await startApiServer({
        resolver,
        port: args.port ? parseInt(args.port) : undefined,
      })
    },
  })
}

function buildApiCmd() {
  // Read static OpenAPI spec
  const spec = JSON.parse(
    readFileSync(new URL('../__generated__/openapi.json', import.meta.url), 'utf-8')
  )

  // Remap verbose spec tags to CLI-friendly group names
  const tagRenames: Record<string, string> = { 'Stateless Sync API': 'pipeline' }
  for (const methods of Object.values(spec.paths ?? {}) as Record<
    string,
    { tags?: string[] }
  >[]) {
    for (const op of Object.values(methods)) {
      if (op.tags) op.tags = op.tags.map((t: string) => tagRenames[t] ?? t)
    }
  }

  // Lazy subprocess: spawned on first request, killed on exit
  let server: ServeSubprocess | undefined

  async function ensureServer(): Promise<string> {
    if (server) return server.url
    server = await spawnServeSubprocess()
    process.on('exit', () => server?.kill())
    return server.url
  }

  const handler = async (req: Request) => {
    const base = await ensureServer()
    const url = new URL(req.url)
    return fetch(new Request(`${base}${url.pathname}${url.search}`, req))
  }

  return createCliFromSpec({
    spec,
    handler,
    exclude: ['health'],
    groupByTag: true,
    tagDescriptions: {
      pipeline: 'Stateless sync operations (check, setup, read, write, sync)',
      Meta: 'Connector metadata and discovery',
    },
    ndjsonBodyStream: () =>
      process.stdin.isTTY ? null : (Readable.toWeb(process.stdin) as ReadableStream),
    meta: {
      name: 'api',
      description: 'Raw API operations (spawns a local engine server)',
      version: '0.1.0',
    },
  })
}

export function createProgram() {
  return defineCommand({
    meta: {
      name: 'sync-engine',
      description: 'Stripe Sync Engine — sync Stripe data to Postgres',
      version: '0.1.0',
    },
    subCommands: {
      serve: createServeCmd(),
      sync: createSyncCmd(),
      supabase: supabaseCmd,
      api: buildApiCmd(),
    },
  })
}
