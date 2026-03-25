import 'dotenv/config'
import { Readable } from 'node:stream'
import { defineCommand } from 'citty'
import { createCliFromSpec } from '@stripe/sync-ts-cli/openapi'
import { createConnectorResolver } from '../lib/index.js'
import { createApp } from '../api/app.js'
import { serveAction } from '../serve-command.js'

// Hand-written workflow command: start HTTP server
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

export async function createProgram() {
  const resolver = createConnectorResolver({})
  const app = createApp(resolver)
  const res = await app.request('/openapi.json')
  const spec = await res.json()

  const specCli = createCliFromSpec({
    spec,
    handler: async (req) => app.fetch(req),
    exclude: ['health'],
    ndjsonBodyStream: () =>
      process.stdin.isTTY ? null : (Readable.toWeb(process.stdin) as ReadableStream),
    meta: {
      name: 'sync-engine',
      description: 'Stripe Sync Engine — sync Stripe data to Postgres',
      version: '0.1.0',
    },
  })

  return defineCommand({
    ...specCli,
    subCommands: { serve: serveCmd, ...specCli.subCommands },
  })
}
