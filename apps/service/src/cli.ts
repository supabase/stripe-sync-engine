import { existsSync, readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { defineCommand } from 'citty'
import type { CommandDef } from 'citty'
import { createCliFromSpec } from '@stripe/sync-ts-cli/openapi'
import { serve } from '@hono/node-server'
import { createConnectorResolver } from '@stripe/sync-engine'
import sourceStripe from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'
import destinationGoogleSheets from '@stripe/sync-destination-google-sheets'
import { createApp } from './api/app.js'
import { wrapPipelineConnectorShorthand } from './lib/cli-connector-shorthand.js'
import { filePipelineStore } from './lib/stores-fs.js'
import { memoryPipelineStore } from './lib/stores-memory.js'
import type { WorkflowClient } from '@temporalio/client'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { logger } from './logger.js'

const defaultDataDir = process.env.DATA_DIR ?? `${homedir()}/.stripe-sync`

const resolverPromise = createConnectorResolver({
  sources: { stripe: sourceStripe },
  destinations: { postgres: destinationPostgres, google_sheets: destinationGoogleSheets },
})

export function resolveGeneratedSpecUrl(
  moduleUrl: string,
  fileExists: (url: URL) => boolean = (url) => existsSync(fileURLToPath(url))
): URL {
  const candidates = [
    new URL('./__generated__/openapi.json', moduleUrl),
    new URL('../src/__generated__/openapi.json', moduleUrl),
  ]

  const specUrl = candidates.find(fileExists)
  if (!specUrl) {
    throw new Error(`Could not find generated OpenAPI spec for ${moduleUrl}`)
  }

  return specUrl
}

async function buildCliSpec() {
  if (import.meta.url.endsWith('.ts')) {
    const resolver = await resolverPromise
    const app = createApp({
      resolver,
      pipelineStore: memoryPipelineStore(),
    })
    const response = await app.request('/openapi.json')
    return response.json()
  }

  return JSON.parse(readFileSync(resolveGeneratedSpecUrl(import.meta.url), 'utf-8'))
}

async function createTemporalClient(
  address: string,
  taskQueue: string
): Promise<{ client: WorkflowClient; taskQueue: string }> {
  const { Client, Connection } = await import('@temporalio/client')
  // Retry connection — Temporal may not accept connections immediately after
  // its health check passes (Docker Compose depends_on race).
  let lastErr: unknown
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const connection = await Connection.connect({ address })
      const client = new Client({ connection })
      return { client: client.workflow, taskQueue }
    } catch (err) {
      lastErr = err
      if (attempt < 9) await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw lastErr
}

async function maybeCreateTemporalClient(
  address: string | undefined,
  taskQueue: string
): Promise<{ client: WorkflowClient; taskQueue: string } | undefined> {
  if (!address) return undefined
  return createTemporalClient(address, taskQueue)
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
      description: 'Temporal server address (e.g. localhost:7233). Optional.',
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
    const temporal = await maybeCreateTemporalClient(args['temporal-address'], taskQueue)
    if (temporal) {
      logger.info(
        {
          temporalAddress: args['temporal-address'],
          taskQueue,
        },
        'Temporal mode enabled'
      )
    } else {
      logger.info('Temporal mode disabled')
    }

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
      description: 'Temporal server address (e.g. localhost:7233). Optional.',
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
    const temporal = await maybeCreateTemporalClient(args['temporal-address'], taskQueue)
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
  const spec = await buildCliSpec()
  const resolver = await resolverPromise

  // Lazy real app — connects to Temporal on first CLI command execution
  let realApp: ReturnType<typeof createApp> | null = null
  async function getApp() {
    if (!realApp) {
      const address = process.env.TEMPORAL_ADDRESS
      const taskQueue = process.env.TEMPORAL_TASK_QUEUE || 'sync-engine'
      const temporal = await maybeCreateTemporalClient(address, taskQueue)
      const dataDir = process.env.DATA_DIR || defaultDataDir
      const pipelineStore = filePipelineStore(dataDir)
      realApp = createApp({ temporal, resolver, pipelineStore })
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

  const subCommands = specCli.subCommands as Record<string, CommandDef> | undefined
  const pipelineGroup = subCommands?.['pipelines'] as CommandDef | undefined
  if (pipelineGroup?.subCommands) {
    const pipelineSubCommands = pipelineGroup.subCommands as Record<string, CommandDef>
    const sourceNames = [...resolver.sources()].map(([name]) => name)
    const destinationNames = [...resolver.destinations()].map(([name]) => name)
    for (const commandName of ['create', 'update']) {
      const command = pipelineSubCommands[commandName]
      if (command) {
        pipelineSubCommands[commandName] = wrapPipelineConnectorShorthand(command, {
          sources: sourceNames,
          destinations: destinationNames,
        })
      }
    }
  }

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
