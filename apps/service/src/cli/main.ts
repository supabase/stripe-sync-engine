import { Readable } from 'node:stream'
import { defineCommand } from 'citty'
import { createCliFromSpec } from '@stripe/sync-ts-cli/openapi'
import { serve } from '@hono/node-server'
import { createApp } from '../api/app.js'
import type { TemporalOptions } from '../lib/temporal.js'

async function createTemporalClient(address: string, taskQueue: string): Promise<TemporalOptions> {
  // Dynamic import — @temporalio/client is an optional dependency
  const { Client, Connection } = await import('@temporalio/client')
  const connection = await Connection.connect({ address })
  const client = new Client({ connection })
  return { client: client.workflow, taskQueue }
}

// Hand-written workflow command: start HTTP server
const serveCmd = defineCommand({
  meta: { name: 'serve', description: 'Start the HTTP API server' },
  args: {
    port: {
      type: 'string',
      default: '4020',
      description: 'HTTP server port',
    },
    'data-dir': {
      type: 'string',
      description: 'Data directory for file stores',
    },
    'temporal-address': {
      type: 'string',
      description:
        'Temporal server address (e.g. localhost:7233). When set, sync lifecycle is managed by Temporal.',
    },
    'temporal-task-queue': {
      type: 'string',
      default: 'sync-engine',
      description: 'Temporal task queue name (default: sync-engine)',
    },
  },
  async run({ args }) {
    const port = Number(args.port)

    let temporal: TemporalOptions | undefined
    if (args['temporal-address']) {
      temporal = await createTemporalClient(
        args['temporal-address'],
        args['temporal-task-queue'] || 'sync-engine'
      )
      console.log(
        `Temporal mode: ${args['temporal-address']} (queue: ${args['temporal-task-queue'] || 'sync-engine'})`
      )
    }

    const app = createApp({
      dataDir: args['data-dir'] || undefined,
      temporal,
    })

    serve({ fetch: app.fetch, port }, () => {
      console.log(`Sync Service listening on http://localhost:${port}`)
      console.log(`API docs: http://localhost:${port}/docs`)
    })
  },
})

export async function createProgram(opts?: { dataDir?: string }) {
  const app = createApp({ dataDir: opts?.dataDir })
  const res = await app.request('/openapi.json')
  const spec = await res.json()

  const specCli = createCliFromSpec({
    spec,
    handler: async (req) => app.fetch(req),
    groupByTag: true,
    exclude: ['health'],
    ndjsonBodyStream: () =>
      process.stdin.isTTY ? null : (Readable.toWeb(process.stdin) as ReadableStream),
    meta: {
      name: 'sync-service',
      description: 'Stripe Sync Service — stateful sync with credential management',
      version: '0.1.0',
    },
  })

  return defineCommand({
    ...specCli,
    subCommands: { serve: serveCmd, ...specCli.subCommands },
  })
}
