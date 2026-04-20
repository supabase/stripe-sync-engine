import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLogger, destination, runWithLogContext, type Logger } from '@stripe/sync-logger'

const defaultDataDir = process.env.DATA_DIR ?? `${homedir()}/.stripe-sync`

export const log = createLogger({ name: 'service' })

export async function withSyncRunLogContext<T>(
  pipelineId: string,
  runId: string,
  fn: () => Promise<T>
): Promise<T> {
  const dir = join(defaultDataDir, 'pipelines', pipelineId, 'sync_run')
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, `${runId}.log`)
  const fileDestination = destination({ dest: logPath, sync: true })

  try {
    return await runWithLogContext({ protocolLogDestinations: [fileDestination] }, fn)
  } finally {
    fileDestination.flushSync?.()
    fileDestination.end?.()
  }
}

/** Returns the log file path for a sync run (without creating it). */
export function syncRunLogPath(pipelineId: string, runId: string): string {
  return join(defaultDataDir, 'pipelines', pipelineId, 'sync_run', `${runId}.log`)
}
