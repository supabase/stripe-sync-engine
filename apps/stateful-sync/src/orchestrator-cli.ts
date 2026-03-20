import fs from 'node:fs'
import type { Destination, Source } from '@stripe/sync-protocol'
import pg from 'pg'
import { PostgresOrchestrator, type Sync } from './orchestrator'
import { PostgresStateManager } from './stateManager'

export interface OrchestratorCliOptions {
  command: 'run'
  config: string // path to sync config JSON
  pgUrl: string // postgres connection string for state management
  schema?: string // schema for state tables (default: 'stripe')
}

function loadJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

/**
 * CLI entrypoint for the Postgres orchestrator.
 *
 * Commands:
 *   run --config <path> --pg-url <url>  Run the full sync pipeline.
 *                                        Emits StateMessage checkpoints as NDJSON to stdout.
 *
 * Source and destination must be passed programmatically — the orchestrator
 * is connector-agnostic and cannot dynamically import them from config.
 */
export async function main(
  opts: OrchestratorCliOptions,
  source: Source,
  destination: Destination
): Promise<void> {
  const sync = loadJson(opts.config) as Sync

  if (opts.command === 'run') {
    const pool = new pg.Pool({ connectionString: opts.pgUrl })
    const schema = opts.schema ?? 'stripe'
    const stateManager = new PostgresStateManager(pool, { schema })

    const orchestrator = new PostgresOrchestrator(sync, stateManager, {
      onLog: (message, level) => {
        process.stderr.write(JSON.stringify({ type: 'log', level, message }) + '\n')
      },
      onError: (message, failureType) => {
        process.stderr.write(
          JSON.stringify({ type: 'error', failure_type: failureType, message }) + '\n'
        )
      },
    })

    try {
      const checkpoints = await orchestrator.run(source, destination)
      for (const msg of checkpoints) {
        process.stdout.write(JSON.stringify(msg) + '\n')
      }
    } finally {
      await pool.end()
    }
    return
  }

  throw new Error(`Unknown command: ${opts.command}`)
}
