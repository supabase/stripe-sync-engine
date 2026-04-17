import type { EofPayload, PipelineConfig, SourceStateMessage } from '@stripe/sync-protocol'
import { emptySyncState, type SyncOutput, type SyncState } from '@stripe/sync-protocol'
import type { Engine, SourceReadOptions } from './engine.js'

export interface PipelineSyncUntilCompleteOptions extends Omit<SourceReadOptions, 'state'> {
  state?: SyncState
  onAttempt?: (attempt: number, state: SyncState | undefined) => void | Promise<void>
  onMessage?: (message: SyncOutput, attempt: number) => void | Promise<void>
  onState?: (state: SyncState, attempt: number) => void | Promise<void>
}

export interface PipelineSyncUntilCompleteResult {
  attempts: number
  state: SyncState
  eof: EofPayload
}

function mergeStateMessage(state: SyncState | undefined, msg: SourceStateMessage): SyncState {
  const next = structuredClone(state ?? emptySyncState())
  if (msg.source_state.state_type === 'global') {
    next.source.global = msg.source_state.data as Record<string, unknown>
    return next
  }
  next.source.streams[msg.source_state.stream] = msg.source_state.data
  return next
}

export async function pipelineSyncUntilComplete(
  engine: Engine,
  pipeline: PipelineConfig,
  opts: PipelineSyncUntilCompleteOptions = {}
): Promise<PipelineSyncUntilCompleteResult> {
  const { state: initialState, onAttempt, onMessage, onState, ...readOpts } = opts
  let state = initialState
  let attempts = 0

  while (true) {
    attempts += 1
    await onAttempt?.(attempts, state)

    let eof: EofPayload | undefined
    for await (const message of engine.pipeline_sync(pipeline, { ...readOpts, state })) {
      await onMessage?.(message, attempts)

      if (message.type === 'source_state') {
        state = mergeStateMessage(state, message)
        await onState?.(state, attempts)
      }

      if (message.type === 'eof') {
        eof = message.eof
        if (message.eof.state) {
          state = message.eof.state
          await onState?.(state, attempts)
        }
      }
    }

    if (!eof) {
      throw new Error(`pipeline_sync attempt ${attempts} ended without eof`)
    }

    if (eof.reason === 'complete') {
      return { attempts, state: state ?? emptySyncState(), eof }
    }

    if (eof.reason !== 'state_limit' && eof.reason !== 'time_limit') {
      throw new Error(
        `pipeline_sync attempt ${attempts} ended with unexpected eof reason: ${eof.reason}`
      )
    }
  }
}
