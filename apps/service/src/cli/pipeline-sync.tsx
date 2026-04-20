import type { ProgressPayload } from '@stripe/sync-protocol'
import { formatProgress } from '@stripe/sync-engine/progress'
import type { StreamConfig } from '../lib/createSchemas.js'

const PROGRESS_RENDER_INTERVAL_MS = 200

export interface PipelineSyncOptions {
  handler: (req: Request) => Promise<Response>
  pipelineId: string
  stateLimit?: number
  timeLimit?: number
  syncRunId?: string
  streams?: StreamConfig[]
  useState: boolean
  plain: boolean
}

export async function renderPipelineSync(opts: PipelineSyncOptions) {
  const { handler, pipelineId, stateLimit, timeLimit, syncRunId, streams, useState, plain } =
    opts

  let progress: ProgressPayload | undefined
  let prevProgress: ProgressPayload | undefined
  let lastRenderAt = 0
  let loopState: unknown = undefined
  let sawEof = false

  function renderProgressUpdate(next: ProgressPayload, previous?: ProgressPayload) {
    process.stderr.write(formatProgress(next, previous) + '\n')
    lastRenderAt = Date.now()
  }

  try {
    while (true) {
      const params = new URLSearchParams()
      if (stateLimit) params.set('state_limit', String(stateLimit))
      if (timeLimit) params.set('time_limit', String(timeLimit))
      if (syncRunId) params.set('sync_run_id', syncRunId)
      if (!useState) params.set('no_state', 'true')
      const qs = params.toString() ? `?${params}` : ''

      const body = {
        ...(streams ? { streams } : {}),
        ...(!useState && loopState ? { sync_state: loopState } : {}),
      }

      const res = await handler(
        new Request(`http://localhost/pipelines/${pipelineId}/sync${qs}`, {
          method: 'POST',
          ...(Object.keys(body).length > 0
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }
            : {}),
        })
      )

      if (!res.ok) {
        const text = await res.text()
        try {
          const json = JSON.parse(text)
          process.stderr.write(`Error ${res.status}: ${JSON.stringify(json, null, 2)}\n`)
        } catch {
          process.stderr.write(`Error ${res.status}: ${text}\n`)
        }
        process.exit(1)
      }

      if (!res.body) {
        process.stderr.write('No response body\n')
        process.exit(1)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let hasMore = false
      let endingState: unknown = undefined

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          const msg = JSON.parse(line) as {
            type: string
            progress?: ProgressPayload
            log?: { level?: string; message?: string }
            eof?: { has_more?: boolean; ending_state?: unknown; run_progress?: ProgressPayload }
          }

          if (msg.type === 'progress' && msg.progress) {
            prevProgress = progress
            progress = msg.progress
            if (Date.now() - lastRenderAt >= PROGRESS_RENDER_INTERVAL_MS) {
              renderProgressUpdate(progress, prevProgress)
            }
          } else if (msg.type === 'eof' && msg.eof?.run_progress) {
            prevProgress = progress
            progress = msg.eof.run_progress
            hasMore = msg.eof.has_more === true
            endingState = msg.eof.ending_state
            sawEof = true
            renderProgressUpdate(progress, prevProgress)
          } else if (msg.type === 'log' && msg.log?.level === 'error') {
            process.stderr.write(`${msg.log.message ?? 'Sync failed'}\n`)
            process.exit(1)
          }
        }
      }

      if (!sawEof) {
        process.stderr.write('Sync stream ended without eof\n')
        process.exit(1)
      }

      if (!hasMore) {
        break
      }

      if (!useState) {
        if (!endingState) {
          process.stderr.write('Sync returned has_more=true without ending_state\n')
          process.exit(1)
        }
        loopState = endingState
      }
    }
  } finally {
    if (!plain && progress) {
      process.stderr.write(formatProgress(progress) + '\n')
    }
  }
}
