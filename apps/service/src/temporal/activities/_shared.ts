import { heartbeat } from '@temporalio/activity'
import type { Message, Engine } from '@stripe/sync-engine'
import { createRemoteEngine } from '@stripe/sync-engine'
import type { EofPayload, SyncState } from '@stripe/sync-protocol'
import type { PipelineStore } from '../../lib/stores.js'

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

export async function* asIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

export function pipelineHeader(config: Record<string, unknown>): string {
  return JSON.stringify(config)
}

export async function drainMessages(
  stream: AsyncIterable<Message>,
  _initialState?: SyncState
): Promise<{
  sourceConfig?: Record<string, unknown>
  destConfig?: Record<string, unknown>
  eof?: EofPayload
}> {
  let sourceConfig: Record<string, unknown> | undefined
  let destConfig: Record<string, unknown> | undefined
  let eof: EofPayload | undefined
  let count = 0
  let lastHb = 0

  for await (const message of stream) {
    count++
    if (message.type === 'eof') {
      eof = message.eof
    } else if (message.type === 'control') {
      if (message.control.control_type === 'source_config') {
        sourceConfig = message.control.source_config!
      } else if (message.control.control_type === 'destination_config') {
        destConfig = message.control.destination_config!
      }
    }
    const now = Date.now()
    if (now - lastHb >= 15_000) {
      heartbeat({ messages: count })
      lastHb = now
    }
  }
  heartbeat({ messages: count })

  return { sourceConfig, destConfig, eof }
}
