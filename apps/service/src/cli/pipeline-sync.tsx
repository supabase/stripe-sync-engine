import React from 'react'
import { randomUUID } from 'node:crypto'
import { render, Box, Text } from 'ink'
import type { ProgressPayload, StreamProgress } from '@stripe/sync-protocol'
import type { StreamConfig } from '../lib/createSchemas.js'
import { createSyncRunLogger, syncRunLogPath } from '../logger.js'

const PROGRESS_RENDER_INTERVAL_MS = 200

// MARK: - Ink Progress Components (local to avoid cross-package React issues)

function StatusIcon({ status }: { status: string }) {
  const icons: Record<string, { symbol: string; color: string }> = {
    not_started: { symbol: '○', color: 'gray' },
    started: { symbol: '●', color: 'yellow' },
    completed: { symbol: '●', color: 'green' },
    skipped: { symbol: '⏭', color: 'gray' },
    errored: { symbol: '●', color: 'red' },
  }
  const icon = icons[status] ?? { symbol: '?', color: 'white' }
  return <Text color={icon.color}>{icon.symbol} </Text>
}

function StreamRow({ name, stream }: { name: string; stream: StreamProgress }) {
  const showCount = stream.record_count > 0 || stream.status === 'completed'
  return (
    <Box>
      <StatusIcon status={stream.status} />
      <Box minWidth={35}>
        <Text>{name}</Text>
      </Box>
      {showCount && (
        <Text dimColor>{String(stream.record_count).padStart(8)} records</Text>
      )}
      {stream.message && <Text dimColor> {stream.message.slice(0, 80)}</Text>}
    </Box>
  )
}

function SyncProgressView({ progress, prev }: { progress: ProgressPayload; prev?: ProgressPayload }) {
  const entries = Object.entries(progress.streams)
  const elapsed = (progress.elapsed_ms / 1000).toFixed(1)
  const totalRecords = entries.reduce((sum, [, s]) => sum + s.record_count, 0)

  const counts: Record<string, number> = {}
  for (const [, s] of entries) {
    counts[s.status] = (counts[s.status] ?? 0) + 1
  }
  const parts: string[] = []
  if (counts.completed) parts.push(`${counts.completed} completed`)
  if (counts.started) parts.push(`${counts.started} started`)
  if (counts.errored) parts.push(`${counts.errored} errored`)
  if (counts.skipped) parts.push(`${counts.skipped} skipped`)
  if (counts.not_started) parts.push(`${counts.not_started} not_started`)

  const statusLabel =
    progress.derived.status === 'failed' ? 'Sync failed'
    : progress.derived.status === 'succeeded' ? 'Sync complete'
    : 'Syncing'
  const statusColor =
    progress.derived.status === 'failed' ? 'red'
    : progress.derived.status === 'succeeded' ? 'green'
    : 'yellow'

  const visible = entries.filter(([, s]) => s.status !== 'not_started')
  const notStarted = entries.filter(([, s]) => s.status === 'not_started')

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={statusColor} bold>{statusLabel}</Text>
        <Text dimColor> {entries.length} streams ({parts.join(', ')}) — {totalRecords.toLocaleString()} records, {progress.derived.records_per_second.toFixed(1)}/s — {elapsed}s</Text>
      </Box>
      <Box flexDirection="column" marginLeft={1}>
        {visible.map(([name, stream]) => (
          <StreamRow key={name} name={name} stream={stream} />
        ))}
        {notStarted.length > 0 && (
          <Box>
            <Text color="gray">○ </Text>
            <Text dimColor>{notStarted.map(([n]) => n).join(', ')}</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

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
  const { handler, pipelineId, stateLimit, timeLimit, streams, useState, plain } = opts
  const syncRunId = opts.syncRunId ?? randomUUID()

  // Set up file logger for this sync run
  const logFile = syncRunLogPath(pipelineId, syncRunId)
  const log = createSyncRunLogger(pipelineId, syncRunId)
  log.info({ pipelineId, syncRunId, stateLimit, timeLimit, streams, useState }, 'sync run started')
  process.stderr.write(`Log: ${logFile}\n`)

  function exit(code: number): never {
    inkInstance?.unmount()
    log.flush()
    process.exit(code)
  }

  const inkInstance = plain ? null : render(<></>, { stdout: process.stderr })

  let progress: ProgressPayload | undefined
  let prevProgress: ProgressPayload | undefined
  let lastRenderAt = 0
  let loopState: unknown = undefined
  let sawEof = false

  function renderProgressUpdate(next: ProgressPayload, previous?: ProgressPayload) {
    if (inkInstance) {
      inkInstance.rerender(<SyncProgressView progress={next} prev={previous} />)
    } else {
      // Plain mode: just print the header line
      const entries = Object.entries(next.streams)
      const total = entries.length
      const totalRecords = entries.reduce((sum, [, s]) => sum + s.record_count, 0)
      const elapsed = (next.elapsed_ms / 1000).toFixed(1)
      process.stderr.write(`${total} streams, ${totalRecords} records, ${elapsed}s\n`)
    }
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
            stream_status?: { stream?: string; status?: string; message?: string }
            eof?: { has_more?: boolean; ending_state?: unknown; run_progress?: ProgressPayload }
          }

          // Log all messages to file (except progress which is too chatty)
          if (msg.type !== 'progress') {
            log.debug({ msg_type: msg.type, ...msg }, 'message')
          }

          if (msg.type === 'progress' && msg.progress) {
            prevProgress = progress
            progress = msg.progress
            if (Date.now() - lastRenderAt >= PROGRESS_RENDER_INTERVAL_MS) {
              renderProgressUpdate(progress, prevProgress)
            }
          } else if (msg.type === 'stream_status' && msg.stream_status) {
            log.info(msg.stream_status, `stream ${msg.stream_status.status}`)
          } else if (msg.type === 'eof' && msg.eof?.run_progress) {
            prevProgress = progress
            progress = msg.eof.run_progress
            hasMore = msg.eof.has_more === true
            endingState = msg.eof.ending_state
            sawEof = true
            log.info({ has_more: hasMore }, 'sync iteration complete')
            renderProgressUpdate(progress, prevProgress)
          } else if (msg.type === 'log' && msg.log?.level === 'error') {
            log.error({ message: msg.log.message }, 'sync error')
            process.stderr.write(`${msg.log.message ?? 'Sync failed'}\n`)
            exit(1)
          }
        }
      }

      if (!sawEof) {
        process.stderr.write('Sync stream ended without eof\n')
        exit(1)
      }

      if (!hasMore) {
        break
      }

      if (!useState) {
        if (!endingState) {
          process.stderr.write('Sync returned has_more=true without ending_state\n')
          exit(1)
        }
        loopState = endingState
      }
    }
  } finally {
    inkInstance?.unmount()
    log.info('sync run finished')
    log.flush()
  }
}
