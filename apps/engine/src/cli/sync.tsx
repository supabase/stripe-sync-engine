import React from 'react'
import { render } from 'ink'
import { defineCommand } from 'citty'
import { spawn, type ChildProcess } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { readonlyStateStore, type StateStore } from '../lib/state-store.js'
import { createRemoteEngine } from '../lib/remote-engine.js'
import { type PipelineConfig, type SyncState, type ProgressPayload, emptySyncState } from '@stripe/sync-protocol'
import { ProgressView } from '../lib/progress/format.js'

export function createSyncCmd() {
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
      baseUrl: {
        type: 'string',
        description: 'Stripe API base URL (default: https://api.stripe.com)',
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
      if (args.baseUrl) {
        stripeConfig.base_url = args.baseUrl
      }
      if (backfillLimit) {
        stripeConfig.backfill_limit = backfillLimit
      }
      if (args.live) {
        stripeConfig.websocket = true
      }

      // Spawn engine HTTP server as a subprocess — logs go to a file, Ink owns the terminal
      const port = await getAvailablePort()
      const logFile = `sync-${args.schema}.log`
      const logFd = openSync(logFile, 'w')
      const child = spawnServeProcess(port, logFd)

      try {
        const engineUrl = `http://localhost:${port}`
        await waitForServer(engineUrl)
        const engine = createRemoteEngine(engineUrl)

        // Create tables before syncing (must drain — await alone no-ops on AsyncIterable)
        for await (const _msg of engine.pipeline_setup(pipeline)) {
          // drain setup messages (table creation, etc.)
        }

        const syncState: SyncState | undefined = initialState
          ? { ...emptySyncState(), source: initialState }
          : undefined
        const output = engine.pipeline_sync(pipeline, { state: syncState, time_limit: timeLimit })

        // Render progress with Ink (live updating, renders to stderr)
        let progress: ProgressPayload | undefined
        let prevProgress: ProgressPayload | undefined
        const { rerender, unmount } = render(<></>, { stdout: process.stderr })

        for await (const msg of output) {
          if (msg.type === 'source_state') {
            if (msg.source_state.state_type === 'global') {
              await store.setGlobal(msg.source_state.data)
            } else {
              await store.set(msg.source_state.stream, msg.source_state.data)
            }
          } else if (msg.type === 'progress') {
            prevProgress = progress
            progress = msg.progress
            rerender(<ProgressView progress={progress} prev={prevProgress} />)
          } else if (msg.type === 'eof') {
            prevProgress = progress
            progress = msg.eof.run_progress
            rerender(<ProgressView progress={progress} prev={prevProgress} />)
          }
        }

        unmount()
      } finally {
        child.kill()
        closeSync(logFd)
        if ('close' in store && typeof store.close === 'function') {
          await store.close()
        }
      }
    },
  })
}

/** Spawn `sync-engine serve` as a child process with logs piped to a file descriptor. */
function spawnServeProcess(port: number, logFd: number): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--use-env-proxy', '--import', 'tsx', 'apps/engine/src/bin/serve.ts'],
    {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', logFd, logFd],
    }
  )
  child.on('error', (err) => {
    throw new Error(`Failed to spawn engine server: ${err.message}`)
  })
  return child
}

/** Find an available TCP port by briefly binding to port 0. */
async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, () => {
      const { port } = srv.address() as AddressInfo
      srv.close((err) => (err ? reject(err) : resolve(port)))
    })
    srv.on('error', reject)
  })
}

/** Poll the server's /health endpoint until it responds or timeout. */
async function waitForServer(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) return
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Engine server at ${url} did not start within ${timeoutMs}ms`)
}

async function getStateStore(connectionString: string, schema: string) {
  const pkg = await import('@stripe/sync-state-postgres')
  const stateConfig = { connection_string: connectionString, schema }
  await pkg.setupStateStore(stateConfig)
  return pkg.createStateStore(stateConfig) as import('../lib/state-store.js').StateStore & {
    close(): Promise<void>
  }
}
