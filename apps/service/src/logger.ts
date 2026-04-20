import pino from 'pino'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLogger } from '@stripe/sync-logger'

const defaultDataDir = process.env.DATA_DIR ?? `${homedir()}/.stripe-sync`

const baseOpts: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['*.api_key', '*.connection_string', '*.password', '*.url'],
    censor: '[redacted]',
  },
}

export const log = createLogger({
  ...baseOpts,
  name: 'service',
  destination: pino.destination({ dest: 1, sync: false }),
})

/**
 * Create a file-based logger for a sync run.
 * Writes to DATA_DIR/pipelines/$pipelineId/sync_run/$runId.log
 * Uses sync mode so the file is ready immediately (CLI use case).
 */
export function createSyncRunLogger(pipelineId: string, runId: string): pino.Logger {
  const dir = join(defaultDataDir, 'pipelines', pipelineId, 'sync_run')
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, `${runId}.log`)
  return createLogger({
    ...baseOpts,
    name: 'service',
    destination: pino.destination({ dest: logPath, sync: true }),
  })
}

/** Returns the log file path for a sync run (without creating it). */
export function syncRunLogPath(pipelineId: string, runId: string): string {
  return join(defaultDataDir, 'pipelines', pipelineId, 'sync_run', `${runId}.log`)
}
