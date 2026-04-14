import { heartbeat } from '@temporalio/activity'
import type { Message, Engine } from '@stripe/sync-engine'
import { createRemoteEngine } from '@stripe/sync-engine'
import type { EofPayload, SourceStateMessage, SyncState } from '@stripe/sync-protocol'
import { emptySyncState } from '@stripe/sync-protocol'
import type { PipelineStore } from '../../lib/stores.js'
import type { SyncRunError } from '../sync-errors.js'

export interface ActivitiesContext {
  /** Remote engine client — satisfies the {@link Engine} interface over HTTP. Drop-in replacement for a local engine. */
  engine: Engine
  pipelineStore: PipelineStore
}

export function createActivitiesContext(opts: {
  engineUrl: string
  pipelineStore: PipelineStore
}): ActivitiesContext {
  const { engineUrl, pipelineStore } = opts
  return {
    engine: createRemoteEngine(engineUrl),
    pipelineStore,
  }
}

export interface RunResult {
  errors: SyncRunError[]
  state: SyncState
}

export async function* asIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

export function pipelineHeader(config: Record<string, unknown>): string {
  return JSON.stringify(config)
}

export function mergeStateMessage(state: SyncState, msg: SourceStateMessage): SyncState {
  if (msg.source_state.state_type === 'global') {
    return {
      ...state,
      source: { ...state.source, global: msg.source_state.data as Record<string, unknown> },
    }
  }
  return {
    ...state,
    source: {
      ...state.source,
      streams: { ...state.source.streams, [msg.source_state.stream]: msg.source_state.data },
    },
  }
}

export function collectError(message: Message): RunResult['errors'][number] | null {
  if (message.type === 'trace' && message.trace.trace_type === 'error') {
    return {
      message: message.trace.error.message || 'Unknown error',
      failure_type: message.trace.error.failure_type,
      stream: message.trace.error.stream,
    }
  }
  return null
}

export async function drainMessages(
  stream: AsyncIterable<Message>,
  initialState?: SyncState
): Promise<{
  errors: RunResult['errors']
  state: SyncState
  records: Message[]
  sourceConfig?: Record<string, unknown>
  destConfig?: Record<string, unknown>
  eof?: EofPayload
}> {
  const errors: RunResult['errors'] = []
  let state: SyncState = initialState ?? emptySyncState()
  const records: Message[] = []
  let sourceConfig: Record<string, unknown> | undefined
  let destConfig: Record<string, unknown> | undefined
  let eof: EofPayload | undefined
  let count = 0

  for await (const message of stream) {
    count++
    if (message.type === 'eof') {
      eof = message.eof
      if (eof.stream_progress) {
        const engineStreams: Record<string, unknown> = { ...state.engine.streams }
        for (const [name, sp] of Object.entries(eof.stream_progress)) {
          engineStreams[name] = { cumulative_record_count: sp.cumulative_record_count }
        }
        state = { ...state, engine: { ...state.engine, streams: engineStreams } }
      }
    } else if (message.type === 'control') {
      if (message.control.control_type === 'source_config') {
        sourceConfig = message.control.source_config!
      } else if (message.control.control_type === 'destination_config') {
        destConfig = message.control.destination_config!
      }
    } else {
      const error = collectError(message)
      if (error) {
        errors.push(error)
      } else if (message.type === 'source_state') {
        state = mergeStateMessage(state, message)
      } else if (message.type === 'record') {
        records.push(message)
      }
    }
    if (count % 50 === 0) heartbeat({ messages: count })
  }
  if (count % 50 !== 0) heartbeat({ messages: count })

  return { errors, state, records, sourceConfig, destConfig, eof }
}
