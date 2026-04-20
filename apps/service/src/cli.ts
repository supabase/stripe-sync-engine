import { Readable } from 'node:stream'
import { defineCommand } from 'citty'
import type { CommandDef } from 'citty'
import { createCliFromSpec } from '@stripe/sync-ts-cli/openapi'
import { createPrettyFormatter } from './cli/pretty-output.js'
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
import type { StreamConfig } from './lib/createSchemas.js'
import { homedir } from 'node:os'
import { logger } from './logger.js'

const defaultDataDir = process.env.DATA_DIR ?? `${homedir()}/.stripe-sync`

const resolverPromise = createConnectorResolver({
  sources: { stripe: sourceStripe },
  destinations: { postgres: destinationPostgres, google_sheets: destinationGoogleSheets },
})

async function buildCliSpec() {
  const resolver = await resolverPromise
  const app = createApp({
    resolver,
    pipelineStore: memoryPipelineStore(),
  })
  const response = await app.request('/openapi.json')
  return response.json()
}

function parseStreamsArg(raw: string | undefined): StreamConfig[] | undefined {
  if (!raw) return undefined

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error('Expected JSON array')
    }
    return parsed.map((item) =>
      typeof item === 'string' ? ({ name: item } satisfies StreamConfig) : (item as StreamConfig)
    )
  } catch {
    return raw
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ name }))
  }
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
    'engine-url': {
      type: 'string',
      description:
        'Optional sync engine URL for ad-hoc sync execution. If omitted, runs in-process.',
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

    const engineUrl = args['engine-url'] || undefined
    const app = createApp({ temporal, resolver, pipelineStore, engineUrl })

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

  const serviceUrl = process.env.SERVICE_URL

  // Lazy real app — boots in-process when no SERVICE_URL is provided
  let engineUrl: string | undefined = process.env.ENGINE_URL
  let realApp: ReturnType<typeof createApp> | null = null
  async function getApp() {
    if (!realApp) {
      const address = process.env.TEMPORAL_ADDRESS
      const taskQueue = process.env.TEMPORAL_TASK_QUEUE || 'sync-engine'
      const temporal = await maybeCreateTemporalClient(address, taskQueue)
      const dataDir = process.env.DATA_DIR || defaultDataDir
      const pipelineStore = filePipelineStore(dataDir)
      realApp = createApp({ temporal, resolver, pipelineStore, engineUrl })
    }
    return realApp
  }

  const handler = serviceUrl
    ? async (req: Request) => {
        // Forward to a running service server
        const url = new URL(req.url)
        const target = new URL(url.pathname + url.search, serviceUrl)
        return fetch(target, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          duplex: 'half',
        } as RequestInit)
      }
    : async (req: Request) => {
        const app = await getApp()
        return app.fetch(req)
      }

  // Use pretty formatting by default in TTY, raw JSON with --json or when piped
  const useJson = process.argv.includes('--json') || !process.stdout.isTTY
  const responseFormatter = useJson ? undefined : createPrettyFormatter()

  const specCli = createCliFromSpec({
    spec,
    handler,
    groupByTag: true,
    exclude: ['health'],
    ndjsonBodyStream: () =>
      process.stdin.isTTY ? null : (Readable.toWeb(process.stdin) as ReadableStream),
    responseFormatter,
    rootArgs: {
      json: {
        type: 'boolean',
        default: false,
        description: 'Output raw JSON instead of pretty-printed format',
      },
    },
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

    const getCommand = pipelineSubCommands['get']
    if (getCommand && !pipelineSubCommands['check']) {
      pipelineSubCommands['check'] = defineCommand({
        ...getCommand,
        meta: {
          name: 'check',
          description: 'Retrieve pipeline',
        },
      })
    }

    // Override the auto-generated sync command with an Ink-based progress display
    pipelineSubCommands['sync'] = defineCommand({
      meta: { name: 'sync', description: 'Run sync for a pipeline' },
      args: {
        id: { type: 'positional', required: true, description: 'Pipeline ID' },
        stateLimit: { type: 'string', description: 'Max state messages before stopping' },
        timeLimit: { type: 'string', description: 'Stop after N seconds' },
        syncRunId: {
          type: 'string',
          description: 'Sync run identifier (resumes or starts fresh)',
        },
        streams: {
          type: 'string',
          description: 'Stream override as comma-separated names or JSON array',
        },
        engineUrl: {
          type: 'string',
          description: 'Sync engine URL (overrides ENGINE_URL env var)',
        },
        state: {
          type: 'boolean',
          default: true,
          description: 'Resume from and persist sync state (--no-state disables this)',
        },
        plain: {
          type: 'boolean',
          default: false,
          description: 'Plain text output (no Ink/ANSI)',
        },
      },
      async run({ args }) {
        if (args.engineUrl) {
          engineUrl = args.engineUrl
        }
        const { renderPipelineSync } = await import('./cli/pipeline-sync.js')
        await renderPipelineSync({
          handler,
          pipelineId: args.id as string,
          stateLimit: args.stateLimit ? parseInt(args.stateLimit) : undefined,
          timeLimit: args.timeLimit ? parseInt(args.timeLimit) : undefined,
          syncRunId: args.syncRunId,
          streams: parseStreamsArg(args.streams),
          useState: args.state !== false,
          plain: args.plain || !process.stderr.isTTY,
        })
      },
    }) as CommandDef
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
