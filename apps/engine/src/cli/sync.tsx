import React from 'react'
import { render } from 'ink'
import { defineCommand } from 'citty'
import { createEngine, createRemoteEngine, type ConnectorResolver } from '../lib/index.js'
import { type PipelineConfig, type ProgressPayload } from '@stripe/sync-protocol'
import { ProgressView, formatProgress } from '../lib/progress/format.js'
import { applyControlToPipeline } from './source-config-cache.js'

const PROGRESS_RENDER_INTERVAL_MS = 200

export function createSyncCmd(resolverPromise: Promise<ConnectorResolver>) {
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
      engineUrl: {
        type: 'string',
        description: 'URL of a running sync-engine server (skips spawning a subprocess)',
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

      const stripeConfig: Record<string, unknown> = {
        api_key: stripeApiKey,
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

      const engine = args.engineUrl
        ? createRemoteEngine(args.engineUrl)
        : await createEngine(await resolverPromise)

      // Run connector setup and apply any config updates before syncing.
      for await (const msg of engine.pipeline_setup(pipeline)) {
        if (msg.type !== 'control') continue
        pipeline = applyControlToPipeline(pipeline, msg.control)
      }

      const output = engine.pipeline_sync(pipeline, { time_limit: timeLimit })

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
    },
  })
}
