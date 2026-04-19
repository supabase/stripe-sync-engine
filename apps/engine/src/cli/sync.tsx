import React from 'react'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { render } from 'ink'
import { defineCommand } from 'citty'
import { readonlyStateStore, fileStateStore, type StateStore } from '../lib/state-store.js'
import { createConnectorResolver, createEngine } from '../lib/index.js'
import { type PipelineConfig, type SyncState, type ProgressPayload, emptySyncState } from '@stripe/sync-protocol'
import { ProgressView, formatProgress } from '../lib/progress/format.js'
import { defaultConnectors } from '../lib/default-connectors.js'
import {
  applyControlToPipeline,
  readPersistedStripeSourceConfig,
  writePersistedStripeSourceConfig,
} from './source-config-cache.js'

const PROGRESS_RENDER_INTERVAL_MS = 200

export function createSyncCmd() {
  return defineCommand({
    meta: {
      name: 'sync',
      description: 'Sync Stripe data to Postgres',
    },
    args: {
      // Source (Stripe)
      stripeApiKey: {
        type: 'string',
        description: 'Stripe API key (or STRIPE_API_KEY env)',
      },
      stripeBaseUrl: {
        type: 'string',
        description: 'Stripe API base URL (default: https://api.stripe.com)',
      },
      stripeRateLimit: {
        type: 'string',
        description: 'Max Stripe API requests per second (default: 20 live, 10 test)',
      },
      // Destination (Postgres)
      postgresUrl: {
        type: 'string',
        description: 'Postgres connection string (or POSTGRES_URL env)',
      },
      postgresSchema: {
        type: 'string',
        default: 'public',
        description: 'Target Postgres schema (default: public)',
      },
      // Sync behavior
      streams: {
        type: 'string',
        description: 'Comma-separated stream names (default: all)',
      },
      backfillLimit: {
        type: 'string',
        description: 'Max records to backfill per stream',
      },
      timeLimit: {
        type: 'string',
        description: 'Stop after N seconds',
      },
      state: {
        type: 'string',
        default: 'file',
        description: 'State backend: file (default, ~/.stripe-sync/), postgres, none',
      },
      noState: {
        type: 'boolean',
        default: false,
        description: 'Shorthand for --state none',
      },
      websocket: {
        type: 'boolean',
        default: false,
        description: 'Stay alive for real-time WebSocket events',
      },
      plain: {
        type: 'boolean',
        default: false,
        description: 'Plain text output (no Ink/ANSI, for non-TTY or piping)',
      },
    },
    async run({ args }) {
      const stripeApiKey = args.stripeApiKey || process.env.STRIPE_API_KEY
      const postgresUrl = args.postgresUrl || process.env.POSTGRES_URL
      if (!stripeApiKey) throw new Error('Missing --stripe-api-key or STRIPE_API_KEY env')
      if (!postgresUrl) throw new Error('Missing --postgres-url or POSTGRES_URL env')

      const schema = args.postgresSchema
      const backfillLimit = args.backfillLimit ? parseInt(args.backfillLimit) : undefined
      const timeLimit = args.timeLimit ? parseInt(args.timeLimit) : undefined

      const persistedStripeConfig = readPersistedStripeSourceConfig(sourceConfigCachePath(stripeApiKey))
      const stripeConfig: Record<string, unknown> = {
        api_key: stripeApiKey,
        ...(persistedStripeConfig ?? {}),
      }
      if (args.stripeBaseUrl) stripeConfig.base_url = args.stripeBaseUrl
      if (args.stripeRateLimit) stripeConfig.rate_limit = parseInt(args.stripeRateLimit)
      if (backfillLimit) stripeConfig.backfill_limit = backfillLimit
      if (args.websocket) stripeConfig.websocket = true

      let pipeline: PipelineConfig = {
        source: { type: 'stripe', stripe: stripeConfig },
        destination: {
          type: 'postgres',
          postgres: { url: postgresUrl, schema, port: 5432 },
        },
        streams: args.streams
          ? args.streams.split(',').map((s) => ({ name: s.trim() }))
          : undefined,
      }

      // State store
      const stateMode = args.noState ? 'none' : args.state
      const store: StateStore & { close?(): Promise<void> } =
        stateMode === 'none' ? readonlyStateStore()
        : stateMode === 'postgres' ? await getPostgresStateStore(postgresUrl, schema)
        : defaultFileStateStore(stripeApiKey)
      const initialState = await store.get()

      try {
        const resolver = await createConnectorResolver(defaultConnectors, {
          path: true,
          npm: false,
        })
        const engine = await createEngine(resolver)

        // Run connector setup and apply any config updates before syncing.
        for await (const msg of engine.pipeline_setup(pipeline)) {
          if (msg.type !== 'control') continue
          pipeline = applyControlToPipeline(pipeline, msg.control)
          if (msg.control.control_type === 'source_config' && pipeline.source.type === 'stripe') {
            writePersistedStripeSourceConfig(
              sourceConfigCachePath(stripeApiKey),
              msg.control.source_config
            )
          }
        }

        const syncState: SyncState | undefined = initialState
          ? { ...emptySyncState(), source: initialState }
          : undefined
        const output = engine.pipeline_sync(pipeline, { state: syncState, time_limit: timeLimit })

        let progress: ProgressPayload | undefined
        let prevProgress: ProgressPayload | undefined
        const plain = args.plain || !process.stderr.isTTY
        let lastRenderAt = 0

        // Ink for TTY, plain text for non-TTY / --plain
        const inkInstance = plain ? null : render(<></>, { stdout: process.stderr })

        function renderProgress(next: ProgressPayload, previous?: ProgressPayload) {
          if (inkInstance) {
            inkInstance.rerender(<ProgressView progress={next} prev={previous} />)
          } else {
            process.stderr.write(formatProgress(next, previous) + '\n')
          }
          lastRenderAt = Date.now()
        }

        for await (const msg of output) {
          if (msg.type === 'control') {
            pipeline = applyControlToPipeline(pipeline, msg.control)
            if (msg.control.control_type === 'source_config' && pipeline.source.type === 'stripe') {
              writePersistedStripeSourceConfig(
                sourceConfigCachePath(stripeApiKey),
                msg.control.source_config
              )
            }
          } else
          if (msg.type === 'source_state') {
            if (msg.source_state.state_type === 'global') {
              await store.setGlobal(msg.source_state.data)
            } else {
              await store.set(msg.source_state.stream, msg.source_state.data)
            }
          } else if (msg.type === 'progress') {
            prevProgress = progress
            progress = msg.progress
            if (Date.now() - lastRenderAt >= PROGRESS_RENDER_INTERVAL_MS) {
              renderProgress(progress, prevProgress)
            }
          } else if (msg.type === 'eof') {
            prevProgress = progress
            progress = msg.eof.run_progress
            renderProgress(progress, prevProgress)
          }
        }

        inkInstance?.unmount()
      } finally {
        if (store.close) await store.close()
      }
    },
  })
}

function defaultFileStateStore(apiKey: string): StateStore {
  const hash = createHash('sha256').update(apiKey).digest('hex').slice(0, 12)
  const filePath = join(homedir(), '.stripe-sync', `${hash}.json`)
  return fileStateStore(filePath)
}

function sourceConfigCachePath(apiKey: string): string {
  const hash = createHash('sha256').update(apiKey).digest('hex').slice(0, 12)
  return join(homedir(), '.stripe-sync', `${hash}.source-config.json`)
}

async function getPostgresStateStore(connectionString: string, schema: string) {
  const pkg = await import('@stripe/sync-state-postgres')
  const stateConfig = { connection_string: connectionString, schema }
  await pkg.setupStateStore(stateConfig)
  return pkg.createStateStore(stateConfig) as StateStore & { close(): Promise<void> }
}
