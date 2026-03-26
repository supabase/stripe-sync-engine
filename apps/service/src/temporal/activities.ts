import { heartbeat } from '@temporalio/activity'
import { parseNdjsonStream } from '@stripe/sync-engine'
import type { SyncActivities, RunResult } from './types.js'

/**
 * Resolve a sync's config with credentials inlined from the service,
 * then build the X-Sync-Params header value for the engine API.
 */
async function resolveParams(serviceUrl: string, pipelineId: string): Promise<string> {
  const resp = await fetch(`${serviceUrl}/pipelines/${pipelineId}`)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Failed to resolve pipeline ${pipelineId} (${resp.status}): ${text}`)
  }
  const config = (await resp.json()) as {
    source: { type: string; [k: string]: unknown }
    destination: { type: string; [k: string]: unknown }
    streams?: Array<{ name: string; sync_mode?: string }>
  }
  const { type: source_name, ...source_config } = config.source
  const { type: destination_name, ...destination_config } = config.destination
  return JSON.stringify({
    source_name,
    source_config,
    destination_name,
    destination_config,
    streams: config.streams,
  })
}

export function createActivities(opts: { serviceUrl: string; engineUrl: string }): SyncActivities {
  const { serviceUrl, engineUrl } = opts

  return {
    async setup(syncId) {
      const params = await resolveParams(serviceUrl, syncId)
      const resp = await fetch(`${engineUrl}/setup`, {
        method: 'POST',
        headers: { 'X-Sync-Params': params },
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`Setup failed (${resp.status}): ${text}`)
      }
    },

    async run(syncId, input?) {
      const params = await resolveParams(serviceUrl, syncId)
      const headers: Record<string, string> = { 'X-Sync-Params': params }
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
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`Sync failed (${resp.status}): ${text}`)
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
      const params = await resolveParams(serviceUrl, syncId)
      const resp = await fetch(`${engineUrl}/teardown`, {
        method: 'POST',
        headers: { 'X-Sync-Params': params },
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`Teardown failed (${resp.status}): ${text}`)
      }
    },
  }
}
