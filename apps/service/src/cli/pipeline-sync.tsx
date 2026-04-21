import React from 'react'
import { randomUUID } from 'node:crypto'
import { render } from 'ink'
import { ProgressView, formatProgress } from '@stripe/sync-logger/progress'
import { Message, type ProgressPayload } from '@stripe/sync-protocol'
import type { StreamConfig } from '../lib/createSchemas.js'
import { log, syncRunLogPath, withSyncRunLogContext } from '../logger.js'

const PROGRESS_RENDER_INTERVAL_MS = 200

export interface PipelineSyncOptions {
  handler: (req: Request) => Promise<Response>
  pipelineId: string
  timeLimit?: number
  syncRunId?: string
  streams?: StreamConfig[]
  resetState: boolean
  plain: boolean
  connectorOverrides?: {
    source?: Record<string, unknown>
    destination?: Record<string, unknown>
  }
}

export async function renderPipelineSync(opts: PipelineSyncOptions) {
  const {
    handler,
    pipelineId,
    timeLimit,
    streams,
    resetState,
    plain,
    connectorOverrides,
  } = opts
  const syncRunId = opts.syncRunId ?? randomUUID()

  const logFile = syncRunLogPath(pipelineId, syncRunId)
  process.stderr.write(`Log: ${logFile}\n`)

  await withSyncRunLogContext(pipelineId, syncRunId, async () => {
    log.info(
      { pipelineId, syncRunId, timeLimit, streams, resetState },
      'sync run started'
    )

    function exit(code: number): never {
      inkInstance?.unmount()
      process.exit(code)
    }

    const inkInstance = plain ? null : render(<></>, { stdout: process.stderr })

    let progress: ProgressPayload | undefined
    let prevProgress: ProgressPayload | undefined
    let lastRenderAt = 0
    let isFirstIteration = true
    let finalStatus: string | undefined

    function renderProgressUpdate(next: ProgressPayload, previous?: ProgressPayload) {
      if (inkInstance) {
        inkInstance.rerender(<ProgressView progress={next} prev={previous} />)
      } else {
        process.stderr.write(formatProgress(next, previous) + '\n')
      }
      lastRenderAt = Date.now()
    }

    try {
      while (true) {
        const params = new URLSearchParams()
        if (timeLimit) params.set('time_limit', String(timeLimit))
        if (syncRunId) params.set('run_id', syncRunId)
        if (resetState && isFirstIteration) params.set('reset_state', 'true')
        const qs = params.toString() ? `?${params}` : ''

        const body = {
          ...(streams ? { streams } : {}),
          ...(connectorOverrides?.source ? { source: connectorOverrides.source } : {}),
          ...(connectorOverrides?.destination
            ? { destination: connectorOverrides.destination }
            : {}),
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
          exit(1)
        }

        if (!res.body) {
          process.stderr.write('No response body\n')
          exit(1)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let hasMore = false
        let sawEof = false

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.trim()) continue
            const msg = Message.parse(JSON.parse(line))

            // Log all messages to file (except progress which is too chatty)
            if (msg.type !== 'progress') {
              log.debug({ msg_type: msg.type, ...msg }, 'message')
            }

            if (msg.type === 'progress') {
              prevProgress = progress
              progress = msg.progress
              if (Date.now() - lastRenderAt >= PROGRESS_RENDER_INTERVAL_MS) {
                renderProgressUpdate(progress, prevProgress)
              }
            } else if (msg.type === 'stream_status') {
              log.info(msg.stream_status, `stream ${msg.stream_status.status}`)
            } else if (msg.type === 'eof') {
              prevProgress = progress
              progress = msg.eof.run_progress
              hasMore = msg.eof.has_more === true
              finalStatus = msg.eof.status
              sawEof = true
              log.info({ has_more: hasMore }, 'sync iteration complete')
              renderProgressUpdate(progress, prevProgress)
            } else if (msg.type === 'log' && msg.log.level === 'error') {
              log.error({ message: msg.log.message }, 'sync error')
              process.stderr.write(`${msg.log.message ?? 'Sync failed'}\n`)
            }
          }
        }

        if (!sawEof) {
          process.stderr.write('Sync stream ended without eof\n')
          exit(1)
        }

        if (!hasMore) {
          if (finalStatus) process.stderr.write(`Final status: ${finalStatus}\n`)
          break
        }

        isFirstIteration = false
      }
    } finally {
      inkInstance?.unmount()
      log.info('sync run finished')
    }
  })
}
