import { heartbeat } from '@temporalio/activity'
import { parseNdjsonStream } from '@stripe/sync-engine'
import type { SyncActivities, RunResult } from './types.js'

export function createActivities(serviceUrl: string): SyncActivities {
  return {
    async setup(syncId) {
      const resp = await fetch(`${serviceUrl}/syncs/${syncId}/setup`, {
        method: 'POST',
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`Setup failed (${resp.status}): ${text}`)
      }
    },

    async run(syncId, input?) {
      const headers: Record<string, string> = {}
      let body: string | undefined

      if (input && input.length > 0) {
        headers['Content-Type'] = 'application/x-ndjson'
        body = input.map((item) => JSON.stringify(item)).join('\n') + '\n'
      }

      const resp = await fetch(`${serviceUrl}/syncs/${syncId}/sync`, {
        method: 'POST',
        headers,
        body,
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`Run failed (${resp.status}): ${text}`)
      }

      const errors: RunResult['errors'] = []
      let messageCount = 0

      for await (const msg of parseNdjsonStream(resp.body!)) {
        const m = msg as Record<string, unknown>
        messageCount++

        if (m.type === 'error') {
          errors.push({
            message:
              (m.message as string) ||
              ((m.data as Record<string, unknown>)?.message as string) ||
              'Unknown error',
            failure_type: m.failure_type as string | undefined,
            stream: m.stream as string | undefined,
          })
        }

        if (messageCount % 50 === 0) {
          heartbeat({ messages: messageCount })
        }
      }
      if (messageCount % 50 !== 0) {
        heartbeat({ messages: messageCount })
      }

      return { errors }
    },

    async teardown(syncId) {
      const resp = await fetch(`${serviceUrl}/syncs/${syncId}/teardown`, {
        method: 'POST',
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`Teardown failed (${resp.status}): ${text}`)
      }
    },
  }
}
