import { access, readFile, writeFile } from 'node:fs/promises'
import { defineCommand } from 'citty'
import { parseJsonOrFile } from '@stripe/sync-ts-cli'
import {
  type PipelineConfig,
  PipelineConfig as PipelineConfigSchema,
  coerceSyncState,
  createRemoteEngine,
} from '../index.js'
import { pipelineSyncUntilComplete } from '../lib/backfill.js'

async function readState(path?: string) {
  if (!path) return undefined
  try {
    await access(path)
  } catch {
    return undefined
  }
  return coerceSyncState(JSON.parse(await readFile(path, 'utf8')))
}

async function writeState(path: string | undefined, state: unknown) {
  if (!path) return
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export const backfillCmd = defineCommand({
  meta: {
    name: 'backfill',
    description: 'Call a remote sync engine until pipeline_sync reaches eof:complete',
  },
  args: {
    syncEngineUrl: {
      type: 'string',
      description: 'Remote sync engine base URL (or SYNC_ENGINE_URL env)',
    },
    pipeline: {
      type: 'string',
      description: 'Pipeline config as inline JSON or a JSON file path',
    },
    statePath: {
      type: 'string',
      description: 'Optional JSON file to load/save SyncState between attempts',
    },
    stateLimit: {
      type: 'string',
      default: '100',
      description: 'Per-call state_limit passed to pipeline_sync (default: 100)',
    },
    timeLimit: {
      type: 'string',
      default: '10',
      description: 'Per-call time_limit in seconds passed to pipeline_sync (default: 10)',
    },
  },
  async run({ args }) {
    const syncEngineUrl = args.syncEngineUrl || process.env.SYNC_ENGINE_URL
    if (!syncEngineUrl) throw new Error('Missing --sync-engine-url or SYNC_ENGINE_URL env')
    if (!args.pipeline) throw new Error('Missing --pipeline')

    const pipeline = PipelineConfigSchema.parse(parseJsonOrFile(args.pipeline)) as PipelineConfig
    const state = await readState(args.statePath)
    const stateLimit = parseInt(args.stateLimit, 10)
    const timeLimit = parseInt(args.timeLimit, 10)

    if (!Number.isInteger(stateLimit) || stateLimit <= 0) {
      throw new Error('--state-limit must be a positive integer')
    }
    if (!Number.isInteger(timeLimit) || timeLimit <= 0) {
      throw new Error('--time-limit must be a positive integer')
    }

    const engine = createRemoteEngine(syncEngineUrl)
    const result = await pipelineSyncUntilComplete(engine, pipeline, {
      state,
      state_limit: stateLimit,
      time_limit: timeLimit,
      onAttempt: (attempt, currentState) => {
        console.error(
          JSON.stringify({
            event: 'pipeline_sync_attempt_started',
            attempt,
            state_provided: currentState != null,
          })
        )
      },
      onMessage: (message, attempt) => {
        process.stdout.write(`${JSON.stringify(message)}\n`)
        if (message.type === 'eof') {
          console.error(
            JSON.stringify({
              event: 'pipeline_sync_attempt_finished',
              attempt,
              eof_reason: message.eof.reason,
            })
          )
        }
      },
      onState: async (nextState) => {
        await writeState(args.statePath, nextState)
      },
    })

    await writeState(args.statePath, result.state)
    console.error(
      JSON.stringify({
        event: 'pipeline_sync_complete',
        attempts: result.attempts,
        eof_reason: result.eof.reason,
        state_path: args.statePath ?? null,
      })
    )
  },
})
