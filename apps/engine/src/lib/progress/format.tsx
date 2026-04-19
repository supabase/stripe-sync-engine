import React from 'react'
import { Box, Text, renderToString } from 'ink'
import type { ProgressPayload, StreamProgress } from '@stripe/sync-protocol'

const STATUS_ICON: Record<string, { symbol: string; color: string }> = {
  not_started: { symbol: '○', color: 'gray' },
  started: { symbol: '●', color: 'yellow' },
  completed: { symbol: '●', color: 'green' },
  skipped: { symbol: '⏭', color: 'gray' },
  errored: { symbol: '●', color: 'red' },
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function shortDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

function formatRangeBar(
  timeRange: { gte: string; lt: string },
  completedRanges: { gte: string; lt: string }[]
): string | null {
  const totalMs = new Date(timeRange.lt).getTime() - new Date(timeRange.gte).getTime()
  if (totalMs <= 0) return null
  const completedMs = completedRanges.reduce((sum, r) => {
    const start = Math.max(new Date(r.gte).getTime(), new Date(timeRange.gte).getTime())
    const end = Math.min(new Date(r.lt).getTime(), new Date(timeRange.lt).getTime())
    return sum + Math.max(0, end - start)
  }, 0)
  const ratio = Math.min(1, completedMs / totalMs)
  const width = 20
  const filled = Math.round(ratio * width)
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled)
  return `[${shortDate(timeRange.gte)} ${bar} ${shortDate(timeRange.lt)}]`
}

function StreamRow({ name, stream, prev }: {
  key?: string
  name: string
  stream: StreamProgress
  prev?: StreamProgress
}) {
  const icon = STATUS_ICON[stream.status] ?? { symbol: '?', color: 'white' }
  const delta = prev ? stream.record_count - prev.record_count : 0
  const deltaStr = delta > 0 ? ` (+${delta})`.padStart(9) : ''.padStart(9)
  const showCount = stream.record_count > 0 || stream.status === 'completed'
  const countStr = String(stream.record_count).padStart(8)
  const rangeBar = stream.time_range && stream.completed_ranges
    ? formatRangeBar(stream.time_range, stream.completed_ranges)
    : null

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={icon.color}>{icon.symbol} </Text>
        <Box minWidth={35}><Text>{name}</Text></Box>
        {showCount && (
          <Text dimColor>{countStr} records{deltaStr}</Text>
        )}
      </Box>
      {rangeBar && (
        <Box marginLeft={3}>
          <Text dimColor>{rangeBar}</Text>
        </Box>
      )}
      {(stream.status === 'skipped' || stream.status === 'errored') && stream.message && (
        <Box marginLeft={3}>
          <Text dimColor>{truncate(stream.message, 100)}</Text>
        </Box>
      )}
    </Box>
  )
}

function Header({ progress, prev }: { progress: ProgressPayload; prev?: ProgressPayload }) {
  const streamEntries = Object.entries(progress.streams)
  const total = streamEntries.length
  const elapsed = (progress.elapsed_ms / 1000).toFixed(1)
  const totalRecords = streamEntries.reduce((sum, [, s]) => sum + s.record_count, 0)

  // Status breakdown counts
  const counts: Record<string, number> = {}
  for (const [, s] of streamEntries) {
    counts[s.status] = (counts[s.status] ?? 0) + 1
  }
  const statusParts: string[] = []
  if (counts.completed) statusParts.push(`${counts.completed} completed`)
  if (counts.started) statusParts.push(`${counts.started} started`)
  if (counts.errored) statusParts.push(`${counts.errored} errored`)
  if (counts.skipped) statusParts.push(`${counts.skipped} skipped`)
  if (counts.not_started) statusParts.push(`${counts.not_started} not_started`)
  const streamSummary = statusParts.join(', ')

  const statusLabel =
    progress.derived.status === 'failed' ? 'Sync failed'
    : progress.derived.status === 'succeeded' ? 'Sync complete'
    : 'Syncing'

  const statusColor =
    progress.derived.status === 'failed' ? 'red'
    : progress.derived.status === 'succeeded' ? 'green'
    : 'yellow'

  // Record delta (total across all streams)
  const prevTotalRecords = prev
    ? Object.values(prev.streams).reduce((sum, s) => sum + s.record_count, 0)
    : 0
  const recordDelta = prev ? totalRecords - prevTotalRecords : 0
  const recordDeltaStr = recordDelta > 0 ? ` (+${recordDelta})` : ''

  // Checkpoint delta
  const cpDeltaNum = prev ? progress.global_state_count - prev.global_state_count : 0
  const cpDeltaStr = cpDeltaNum > 0 ? ` (+${cpDeltaNum})` : ''

  // Global error (not attributable to a single stream)
  const errMsg = progress.connection_status?.status === 'failed'
    ? (progress.connection_status.message ?? 'Connection failed')
    : undefined
  const erroredStreams = streamEntries.filter(([, s]) => s.status === 'errored')
  const globalErr = errMsg && erroredStreams.length !== 1 ? errMsg : undefined

  // Build stats — right-align numbers so the line doesn't jump during fast sync.
  const recs = String(totalRecords).padStart(8)
  const recDelta = recordDeltaStr.padStart(9) // " (+99999)" or "         "
  const recRate = `${progress.derived.records_per_second.toFixed(1)}/s`.padStart(10)

  const cps = String(progress.global_state_count).padStart(8)
  const cpDelta = cpDeltaStr.padStart(9)
  const cpRate = `${progress.derived.states_per_second.toFixed(1)}/s`.padStart(10)

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={statusColor} bold>{statusLabel}</Text>
        <Text dimColor> {total} streams ({streamSummary}) — {elapsed}s</Text>
        {globalErr && <Text color="red"> — {truncate(globalErr, 100)}</Text>}
      </Box>
      <Box>
        <Text dimColor>{recs} records{recDelta} {recRate}</Text>
        {progress.global_state_count > 0 && (
          <Text dimColor>  {cps} checkpoints{cpDelta} {cpRate}</Text>
        )}
      </Box>
    </Box>
  )
}

export function ProgressView({ progress, prev }: { progress: ProgressPayload; prev?: ProgressPayload }) {
  const entries = Object.entries(progress.streams)
  const completed = entries.filter(([, s]) => s.status === 'completed')
  const errored = entries.filter(([, s]) => s.status === 'errored')
  const started = entries.filter(([, s]) => s.status === 'started')
  const skipped = entries.filter(([, s]) => s.status === 'skipped')
  const notStarted = entries.filter(([, s]) => s.status === 'not_started')
  const visible = [...errored, ...started, ...completed, ...skipped]

  // Global connection error (not attributable to a specific stream)
  const globalErr = progress.connection_status?.status === 'failed'
    ? (progress.connection_status.message ?? 'Connection failed')
    : undefined

  return (
    <Box flexDirection="column">
      <Header progress={progress} prev={prev} />
      <Box flexDirection="column" marginLeft={1}>
        {visible.map(([name, stream]) => (
          <StreamRow
            key={name}
            name={name}
            stream={stream}
            prev={prev?.streams[name]}
          />
        ))}
        {notStarted.length > 0 && (
          <Box>
            <Text color="gray">○ </Text>
            <Text dimColor>{notStarted.map(([n]) => n).join(', ')}</Text>
          </Box>
        )}
      </Box>
      {globalErr && (
        <Box marginTop={1}>
          <Text color="red">{truncate(globalErr, 120)}</Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * Render progress as a plain text string (for logs, non-TTY output).
 */
export function formatProgress(progress: ProgressPayload, prev?: ProgressPayload): string {
  return renderToString(<ProgressView progress={progress} prev={prev} />)
}
