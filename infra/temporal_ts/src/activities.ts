import { heartbeat } from '@temporalio/activity'
import { parseNdjsonStream } from './ndjson'
import type { SyncConfig, SyncActivities, SyncResult } from './types'

function buildSyncParamsHeader(
  config: SyncConfig,
  opts?: { state?: Record<string, unknown> }
): string {
  const params: Record<string, unknown> = {
    source_name: config.source_name,
    destination_name: config.destination_name,
    source_config: config.source_config,
    destination_config: config.destination_config,
    streams: config.streams,
  }
  if (opts?.state) params.state = opts.state
  return JSON.stringify(params)
}

export function createActivities(engineUrl: string): SyncActivities {
  return {
    async setup(config) {
      const resp = await fetch(`${engineUrl}/setup`, {
        method: 'POST',
        headers: { 'X-Sync-Params': buildSyncParamsHeader(config) },
      })
      if (!resp.ok) throw new Error(`Setup failed: ${resp.status}`)
    },

    async sync(config, input?) {
      const headers: Record<string, string> = {
        'X-Sync-Params': buildSyncParamsHeader(config, {
          state: config.state,
        }),
      }

      let body: string | undefined
      if (input && input.length > 0) {
        headers['Content-Type'] = 'application/x-ndjson'
        body = input.map((item) => JSON.stringify(item)).join('\n') + '\n'
      }

      const resp = await fetch(`${engineUrl}/sync`, {
        method: 'POST',
        headers,
        body,
      })
      if (!resp.ok) throw new Error(`Sync failed: ${resp.status}`)

      // Stream NDJSON response, extracting state and errors
      const state: Record<string, unknown> = {}
      const errors: SyncResult['errors'] = []
      let messageCount = 0

      for await (const msg of parseNdjsonStream(resp.body!)) {
        const m = msg as any
        messageCount++

        if (m.type === 'state' && m.stream) {
          state[m.stream] = m.data
        } else if (m.type === 'error') {
          errors.push({
            message: m.message || m.data?.message || 'Unknown error',
            failure_type: m.failure_type || 'unknown',
            stream: m.stream,
          })
        }

        if (messageCount % 50 === 0) {
          heartbeat({ messages: messageCount })
        }
      }
      if (messageCount % 50 !== 0) {
        heartbeat({ messages: messageCount })
      }

      // Determine completeness: each configured stream must have state[stream].status === 'complete'
      const streamNames = (config.streams ?? []).map((s) => s.name)
      const all_complete =
        streamNames.length > 0 &&
        streamNames.every((name) => {
          const s = state[name] as any
          return s && s.status === 'complete'
        })

      return {
        state,
        all_complete,
        state_count: Object.keys(state).length,
        errors,
      }
    },

    async teardown(config) {
      const resp = await fetch(`${engineUrl}/teardown`, {
        method: 'POST',
        headers: { 'X-Sync-Params': buildSyncParamsHeader(config) },
      })
      if (!resp.ok) throw new Error(`Teardown failed: ${resp.status}`)
    },
  }
}
