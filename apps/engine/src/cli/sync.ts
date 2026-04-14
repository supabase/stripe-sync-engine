import { defineCommand } from 'citty'
import type { Engine } from '../lib/engine.js'
import type { ConnectorResolver } from '../lib/index.js'
import { readonlyStateStore, type StateStore } from '../lib/state-store.js'
import { type PipelineConfig, type SyncState, emptySyncState } from '@stripe/sync-protocol'

export function createSyncCmd(engine: Engine, _resolver: ConnectorResolver) {
  return defineCommand({
    meta: {
      name: 'sync',
      description: 'Sync Stripe data to Postgres',
    },
    args: {
      stripeApiKey: {
        type: 'string',
        description: 'Stripe API key (or STRIPE_API_KEY env)',
      },
      postgresUrl: {
        type: 'string',
        description: 'Postgres connection string (or POSTGRES_URL env)',
      },
      schema: {
        type: 'string',
        default: 'public',
        description: 'Target Postgres schema (default: public)',
      },
      streams: {
        type: 'string',
        description: 'Comma-separated stream names (default: all)',
      },
      state: {
        type: 'string',
        default: 'postgres',
        description: 'State backend: postgres | none (default: postgres)',
      },
      batchSize: {
        type: 'string',
        default: '100',
        description: 'Records per destination flush (default: 100)',
      },
      backfillLimit: {
        type: 'string',
        description: 'Max records to backfill per stream',
      },
      timeLimit: {
        type: 'string',
        description: 'Stop after N seconds',
      },
      live: {
        type: 'boolean',
        default: false,
        description: 'Keep running after backfill and stream live events via WebSocket',
      },
    },
    async run({ args }) {
      const stripeApiKey = args.stripeApiKey || process.env.STRIPE_API_KEY
      const postgresUrl = args.postgresUrl || process.env.POSTGRES_URL
      if (!stripeApiKey) throw new Error('Missing --stripe-api-key or STRIPE_API_KEY env')
      if (!postgresUrl) throw new Error('Missing --postgres-url or POSTGRES_URL env')

      const pipeline: PipelineConfig = {
        source: { type: 'stripe', stripe: { api_key: stripeApiKey } },
        destination: {
          type: 'postgres',
          postgres: {
            url: postgresUrl,
            schema: args.schema,
            port: 5432,
            batch_size: parseInt(args.batchSize),
          },
        },
        streams: args.streams
          ? args.streams.split(',').map((s) => ({ name: s.trim() }))
          : undefined,
      }

      // State store: persist in destination Postgres or discard
      const store: StateStore & { close?(): Promise<void> } =
        args.state === 'none' ? readonlyStateStore() : await getStateStore(postgresUrl, args.schema)
      const initialState = await store.get()

      const timeLimit = args.timeLimit ? parseInt(args.timeLimit) : undefined
      const backfillLimit = args.backfillLimit ? parseInt(args.backfillLimit) : undefined

      // Inject optional source config overrides
      const stripeConfig = pipeline.source.stripe as Record<string, unknown>
      if (backfillLimit) {
        stripeConfig.backfill_limit = backfillLimit
      }
      if (args.live) {
        stripeConfig.websocket = true
      }

      // Create tables before syncing (must drain — await alone no-ops on AsyncIterable)
      for await (const _msg of engine.pipeline_setup(pipeline)) {
        // drain setup messages (table creation, etc.)
      }

      const syncState: SyncState | undefined = initialState
        ? { ...emptySyncState(), source: initialState }
        : undefined
      const output = engine.pipeline_sync(pipeline, { state: syncState, time_limit: timeLimit })

      // Persist state checkpoints and stream NDJSON to stdout
      for await (const msg of output) {
        if (msg.type === 'source_state') {
          if (msg.source_state.state_type === 'global') {
            await store.setGlobal(msg.source_state.data)
          } else {
            await store.set(msg.source_state.stream, msg.source_state.data)
          }
        }
        process.stdout.write(JSON.stringify(msg) + '\n')
      }

      if ('close' in store && typeof store.close === 'function') {
        await store.close()
      }
    },
  })
}

async function getStateStore(connectionString: string, schema: string) {
  const pkg = await import('@stripe/sync-state-postgres')
  const stateConfig = { connection_string: connectionString, schema }
  await pkg.setupStateStore(stateConfig)
  return pkg.createStateStore(stateConfig) as import('../lib/state-store.js').StateStore & {
    close(): Promise<void>
  }
}
