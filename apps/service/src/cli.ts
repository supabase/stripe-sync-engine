import { Readable } from 'node:stream'
import { defineCommand } from 'citty'
import { createCliFromSpec } from '@stripe/sync-ts-cli/openapi'
import { serve } from '@hono/node-server'
import { createConnectorResolver } from '@stripe/sync-engine'
import sourceStripe from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'
import destinationGoogleSheets from '@stripe/sync-destination-google-sheets'
import { createApp } from './api/app.js'
import { filePipelineStore } from './lib/stores-fs.js'
import type { WorkflowClient } from '@temporalio/client'
import { homedir } from 'node:os'
import { logger } from './logger.js'

const defaultDataDir = process.env.DATA_DIR ?? `${homedir()}/.stripe-sync`

const resolverPromise = createConnectorResolver({
  sources: { stripe: sourceStripe },
  destinations: { postgres: destinationPostgres, google_sheets: destinationGoogleSheets },
})

async function createTemporalClient(
  address: string,
  taskQueue: string
): Promise<{ client: WorkflowClient; taskQueue: string }> {
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
    'data-dir': {
      type: 'string',
      default: defaultDataDir,
      description: `Directory to persist pipeline configs as JSON files (default: ${defaultDataDir}).`,
    },
  },
  async run({ args }) {
    const port = Number(args.port)
    const taskQueue = args['temporal-task-queue'] || 'sync-engine'
    const temporal = await createTemporalClient(args['temporal-address'], taskQueue)

    logger.info(
      {
        temporalAddress: args['temporal-address'],
        taskQueue,
      },
      'Temporal mode enabled'
    )

    const resolver = await resolverPromise
    const pipelineStore = filePipelineStore(args['data-dir'])
    logger.info({ dataDir: args['data-dir'] }, 'Pipeline store enabled')

    const app = createApp({ temporal, resolver, pipelineStore })

    serve({ fetch: app.fetch, port }, () => {
      logger.info({ port }, `Sync Service listening on http://localhost:${port}`)
      logger.info({ url: `http://localhost:${port}/docs` }, 'API docs available')
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
    'engine-url': {
      type: 'string',
      default: 'http://localhost:4010',
      description: 'Sync engine URL for sync execution (default: http://localhost:4010)',
    },
    'data-dir': {
      type: 'string',
      default: defaultDataDir,
      description: `Directory to persist pipeline configs as JSON files (default: ${defaultDataDir}).`,
    },
  },
  async run({ args }) {
    const { createWorker } = await import('./temporal/worker.js')
    const taskQueue = args['temporal-task-queue'] || 'sync-engine'
    const namespace = args['temporal-namespace'] || 'default'
    const engineUrl = args['engine-url'] || 'http://localhost:4010'
    const temporalAddress = args['temporal-address']
    const pipelineStore = filePipelineStore(args['data-dir'])

    // import.meta.url is the URL of cli.ts/cli.js, NOT the bin entry point:
    //   tsx:      file:///.../apps/service/src/cli.ts  → ./temporal/workflows/index.ts
    //   compiled: file:///.../apps/service/dist/cli.js → ./temporal/workflows/index.js
    const { fileURLToPath } = await import('node:url')
    const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
    const workflowsPath = fileURLToPath(
      new URL(`./temporal/workflows/index${ext}`, import.meta.url)
    )

    const worker = await createWorker({
      temporalAddress,
      namespace,
      taskQueue,
      engineUrl,
      pipelineStore,
      workflowsPath,
    })

    logger.info({ temporalAddress, namespace, taskQueue, engineUrl }, 'Starting Temporal worker')

    await worker.run()
  },
})

// Standalone webhook ingress command (Temporal mode only)
const webhookCmd = defineCommand({
  meta: { name: 'webhook', description: 'Start the webhook ingress server' },
  args: {
    port: {
      type: 'string',
      default: '4030',
      description: 'HTTP server port (default: 4030)',
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
    'data-dir': {
      type: 'string',
      default: defaultDataDir,
      description: `Directory to persist pipeline configs as JSON files (default: ${defaultDataDir}).`,
    },
  },
  async run({ args }) {
    const port = Number(args.port)
    const taskQueue = args['temporal-task-queue'] || 'sync-engine'
    const temporal = await createTemporalClient(args['temporal-address'], taskQueue)
    const resolver = await resolverPromise
    const pipelineStore = filePipelineStore(args['data-dir'])
    const app = createApp({ temporal, resolver, pipelineStore })

    serve({ fetch: app.fetch, port }, () => {
      logger.info(
        { port, temporalAddress: args['temporal-address'], taskQueue },
        `Webhook server listening on http://localhost:${port}`
      )
    })
  },
})

export async function createProgram() {
  // Mock client/store used only for OpenAPI spec generation (builds CLI structure)
  const mockClient = {
    start: async () => {},
    getHandle: () => ({
      signal: async () => {},
      query: async () => ({}),
      terminate: async () => {},
    }),
    list: async function* () {},
  } as any
  const mockStore = {
    get: async () => ({}),
    set: async () => {},
    update: async () => ({}),
    delete: async () => {},
    list: async () => [],
  } as any

  const resolver = await resolverPromise
  const mockApp = createApp({
    temporal: { client: mockClient, taskQueue: 'cli' },
    resolver,
    pipelineStore: mockStore,
  })
  const res = await mockApp.request('/openapi.json')
  const spec = await res.json()

  // Lazy real app — connects to Temporal on first CLI command execution
  let realApp: ReturnType<typeof createApp> | null = null
  async function getApp() {
    if (!realApp) {
      const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233'
      const taskQueue = process.env.TEMPORAL_TASK_QUEUE || 'sync-engine'
      const temporal = await createTemporalClient(address, taskQueue)
      const r = await resolverPromise
      const dataDir = process.env.DATA_DIR
      if (!dataDir) throw new Error('DATA_DIR environment variable is required')
      const pipelineStore = filePipelineStore(dataDir)
      realApp = createApp({ temporal, resolver: r, pipelineStore })
    }
    return realApp
  }

  const specCli = createCliFromSpec({
    spec,
    handler: async (req) => {
      const app = await getApp()
      return app.fetch(req)
    },
    groupByTag: true,
    exclude: ['health'],
    ndjsonBodyStream: () =>
      process.stdin.isTTY ? null : (Readable.toWeb(process.stdin) as ReadableStream),
    meta: {
      name: 'sync-service',
      description: 'Stripe Sync Service — pipeline management and webhook ingress',
      version: '0.1.0',
    },
  })

  return defineCommand({
    ...specCli,
    subCommands: {
      serve: serveCmd,
      worker: workerCmd,
      webhook: webhookCmd,
      ...specCli.subCommands,
    },
  })
}
