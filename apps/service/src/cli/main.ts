import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { defineCommand } from 'citty'
import { createCliFromSpec } from '@stripe/sync-ts-cli/openapi'
import { serve } from '@hono/node-server'
import { createApp } from '../api/app.js'
import type { TemporalOptions } from '../temporal/bridge.js'

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

// Temporal worker command
const workerCmd = defineCommand({
  meta: { name: 'worker', description: 'Start a Temporal worker for sync workflows' },
  args: {
    'temporal-address': {
      type: 'string',
      required: true,
      description: 'Temporal server address (e.g. localhost:7233)',
    },
    'temporal-namespace': {
      type: 'string',
      default: 'default',
      description: 'Temporal namespace (default: default)',
    },
    'temporal-task-queue': {
      type: 'string',
      default: 'sync-engine',
      description: 'Temporal task queue name (default: sync-engine)',
    },
    'service-url': {
      type: 'string',
      default: 'http://localhost:4020',
      description: 'Sync service URL for config resolution (default: http://localhost:4020)',
    },
    'engine-url': {
      type: 'string',
      default: 'http://localhost:4010',
      description: 'Sync engine URL for sync execution (default: http://localhost:4010)',
    },
  },
  async run({ args }) {
    const { createWorker } = await import('../temporal/worker.js')
    const taskQueue = args['temporal-task-queue'] || 'sync-engine'
    const namespace = args['temporal-namespace'] || 'default'
    const serviceUrl = args['service-url'] || 'http://localhost:4020'
    const engineUrl = args['engine-url'] || 'http://localhost:4010'
    const temporalAddress = args['temporal-address']

    // workflowsPath: resolve relative to the package dist directory
    const pkgDir = path.resolve(import.meta.dirname ?? process.cwd(), '../..')
    const workflowsPath = path.resolve(pkgDir, 'dist/temporal/workflows.js')

    const worker = await createWorker({
      temporalAddress,
      namespace,
      taskQueue,
      serviceUrl,
      engineUrl,
      workflowsPath,
    })

    console.log('Starting Temporal worker...')
    console.log(`  Temporal:    ${temporalAddress} (${namespace})`)
    console.log(`  Task queue:  ${taskQueue}`)
    console.log(`  Service:     ${serviceUrl}`)
    console.log(`  Engine:      ${engineUrl}`)

    await worker.run()
  },
})

// Standalone webhook ingress command (Temporal mode only)
const webhookCmd = defineCommand({
  meta: { name: 'webhook', description: 'Start the webhook ingress server (Temporal mode)' },
  args: {
    port: {
      type: 'string',
      default: '4030',
      description: 'HTTP server port (default: 4030)',
    },
    'data-dir': {
      type: 'string',
      description: 'Data directory — must point at the same store as the sync service',
    },
    'temporal-address': {
      type: 'string',
      required: true,
      description: 'Temporal server address (e.g. localhost:7233)',
    },
    'temporal-task-queue': {
      type: 'string',
      default: 'sync-engine',
      description: 'Temporal task queue name (default: sync-engine)',
    },
  },
  async run({ args }) {
    const { fileConfigStore } = await import('../lib/stores-fs.js')
    const { TemporalBridge } = await import('../temporal/bridge.js')
    const { createWebhookApp } = await import('../api/webhook-app.js')

    const temporal = await createTemporalClient(
      args['temporal-address'],
      args['temporal-task-queue'] || 'sync-engine'
    )
    const dataDir =
      args['data-dir'] || process.env.DATA_DIR || path.join(os.homedir(), '.stripe-sync')
    const configs = fileConfigStore(`${dataDir}/syncs`)
    const bridge = new TemporalBridge(temporal.client, temporal.taskQueue, configs)

    const app = createWebhookApp({ push_event: (id, e) => bridge.pushEvent(id, e) })
    const port = Number(args.port)
    serve({ fetch: app.fetch, port }, () => {
      console.log(`Webhook server listening on http://localhost:${port}`)
      console.log(`  Temporal: ${args['temporal-address']} (queue: ${args['temporal-task-queue'] || 'sync-engine'})`)
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
    exclude: [
      'health',
      // Engine proxy routes — hidden from CLI (use sync-engine CLI directly)
      'setupSync',
      'teardownSync',
      'checkSync',
      'readSync',
      'writeSync',
      'sync',
    ],
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
    subCommands: { serve: serveCmd, worker: workerCmd, webhook: webhookCmd, ...specCli.subCommands },
  })
}
