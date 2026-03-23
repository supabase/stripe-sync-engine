import { heartbeat } from '@temporalio/activity'
import { parseNdjsonStream } from './ndjson'
import type { SyncConfig, SyncActivities, CategorizedMessages } from './types'

function buildSyncParamsHeader(
  config: SyncConfig,
  opts?: { state?: Record<string, unknown>; streams?: Array<{ name: string }> }
): string {
  const params: Record<string, unknown> = {
    source_name: config.source_name,
    destination_name: config.destination_name,
    source_config: config.source_config,
    destination_config: config.destination_config,
    streams: opts?.streams || config.streams,
  }
  if (opts?.state) params.state = opts.state
  return JSON.stringify(params)
}

function categorizeMessages(messages: unknown[]): CategorizedMessages {
  return {
    records: messages.filter((m: any) => m.type === 'record'),
    states: messages.filter((m: any) => m.type === 'state') as CategorizedMessages['states'],
    errors: messages.filter((m: any) => m.type === 'error'),
    stream_statuses: messages.filter(
      (m: any) => m.type === 'stream_status'
    ) as CategorizedMessages['stream_statuses'],
    messages,
  }
}

function extractCursors(messages: unknown[]): Record<string, unknown> {
  const cursors: Record<string, unknown> = {}
  for (const msg of messages) {
    const m = msg as any
    if (m.type === 'state' && m.stream) {
      cursors[m.stream] = m.data
    }
  }
  return cursors
}

/** Stream NDJSON from a fetch response, collecting messages and heartbeating periodically. */
async function streamMessages(resp: Response): Promise<unknown[]> {
  const messages: unknown[] = []
  for await (const msg of parseNdjsonStream(resp.body!)) {
    messages.push(msg)
    if (messages.length % 100 === 0) {
      heartbeat({ records: messages.length })
    }
  }
  if (messages.length % 100 !== 0) {
    heartbeat({ records: messages.length })
  }
  return messages
}

export function createActivities(engineUrl: string): SyncActivities {
  return {
    async healthCheck(config) {
      const resp = await fetch(`${engineUrl}/check`, {
        headers: { 'X-Sync-Params': buildSyncParamsHeader(config) },
      })
      if (!resp.ok) throw new Error(`Health check failed: ${resp.status}`)
      return resp.json()
    },

    async sourceSetup(config) {
      const resp = await fetch(`${engineUrl}/setup`, {
        method: 'POST',
        headers: { 'X-Sync-Params': buildSyncParamsHeader(config) },
      })
      if (!resp.ok) throw new Error(`Source setup failed: ${resp.status}`)
    },

    async destinationSetup(config) {
      const resp = await fetch(`${engineUrl}/setup`, {
        method: 'POST',
        headers: { 'X-Sync-Params': buildSyncParamsHeader(config) },
      })
      if (!resp.ok) throw new Error(`Destination setup failed: ${resp.status}`)
    },

    async backfillPage(config, stream, cursor) {
      const state = cursor ? { [stream]: cursor } : {}
      const resp = await fetch(`${engineUrl}/read`, {
        method: 'POST',
        headers: {
          'X-Sync-Params': buildSyncParamsHeader(config, {
            state,
            streams: [{ name: stream }],
          }),
          'Content-Type': 'application/x-ndjson',
        },
      })
      if (!resp.ok) throw new Error(`Backfill page failed: ${resp.status}`)
      return categorizeMessages(await streamMessages(resp))
    },

    async writeBatch(config, records) {
      const ndjsonBody = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
      const resp = await fetch(`${engineUrl}/write`, {
        method: 'POST',
        headers: {
          'X-Sync-Params': buildSyncParamsHeader(config),
          'Content-Type': 'application/x-ndjson',
        },
        body: ndjsonBody,
      })
      if (!resp.ok) throw new Error(`Write batch failed: ${resp.status}`)
      return categorizeMessages(await streamMessages(resp))
    },

    async processEvent(config, event) {
      // Pass event through source (read)
      const readResp = await fetch(`${engineUrl}/read`, {
        method: 'POST',
        headers: {
          'X-Sync-Params': buildSyncParamsHeader(config),
          'Content-Type': 'application/x-ndjson',
        },
        body: JSON.stringify(event) + '\n',
      })
      if (!readResp.ok) throw new Error(`Process event read failed: ${readResp.status}`)

      const readMessages = await streamMessages(readResp)
      const records = readMessages.filter((m: any) => m.type === 'record')

      if (records.length === 0) {
        return { records_written: 0, state: {} }
      }

      // Forward records to destination (write)
      const ndjsonBody = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
      const writeResp = await fetch(`${engineUrl}/write`, {
        method: 'POST',
        headers: {
          'X-Sync-Params': buildSyncParamsHeader(config),
          'Content-Type': 'application/x-ndjson',
        },
        body: ndjsonBody,
      })
      if (!writeResp.ok) throw new Error(`Process event write failed: ${writeResp.status}`)

      const writeMessages = await streamMessages(writeResp)
      return {
        records_written: records.length,
        state: extractCursors(writeMessages),
      }
    },

    async sourceTeardown(config) {
      const resp = await fetch(`${engineUrl}/teardown`, {
        method: 'POST',
        headers: { 'X-Sync-Params': buildSyncParamsHeader(config) },
      })
      if (!resp.ok) throw new Error(`Source teardown failed: ${resp.status}`)
    },

    async destinationTeardown(config) {
      const resp = await fetch(`${engineUrl}/teardown`, {
        method: 'POST',
        headers: { 'X-Sync-Params': buildSyncParamsHeader(config) },
      })
      if (!resp.ok) throw new Error(`Destination teardown failed: ${resp.status}`)
    },
  }
}
