import React from 'react'
import { render } from 'ink'
import type { ProgressPayload } from '@stripe/sync-protocol'
import { ProgressView, formatProgress } from '@stripe/sync-engine/progress'

const PROGRESS_RENDER_INTERVAL_MS = 200

export interface PipelineSyncOptions {
  handler: (req: Request) => Promise<Response>
  pipelineId: string
  stateLimit?: number
  timeLimit?: number
  syncRunId?: string
  plain: boolean
}

export async function renderPipelineSync(opts: PipelineSyncOptions) {
  const { handler, pipelineId, stateLimit, timeLimit, syncRunId, plain } = opts

  const params = new URLSearchParams()
  if (stateLimit) params.set('state_limit', String(stateLimit))
  if (timeLimit) params.set('time_limit', String(timeLimit))
  if (syncRunId) params.set('sync_run_id', syncRunId)
  const qs = params.toString() ? `?${params}` : ''

  const res = await handler(
    new Request(`http://localhost/pipelines/${pipelineId}/sync${qs}`, { method: 'POST' })
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

  let progress: ProgressPayload | undefined
  let prevProgress: ProgressPayload | undefined
  let lastRenderAt = 0

  const inkInstance = plain ? null : render(<></>, { stdout: process.stderr })

  function renderProgressUpdate(next: ProgressPayload, previous?: ProgressPayload) {
    if (inkInstance) {
      inkInstance.rerender(<ProgressView progress={next} prev={previous} />)
    } else {
      process.stderr.write(formatProgress(next, previous) + '\n')
    }
    lastRenderAt = Date.now()
  }

  // Stream NDJSON and render progress
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
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
          eof?: { run_progress?: ProgressPayload }
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
          renderProgressUpdate(progress, prevProgress)
        }
      }
    }
  } finally {
    inkInstance?.unmount()
  }
}
