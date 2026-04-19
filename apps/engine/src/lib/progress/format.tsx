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

function StreamRow({ name, stream, prev, errorMsg }: {
  name: string
  stream: StreamProgress
  prev?: StreamProgress
  errorMsg?: string
}) {
  const icon = STATUS_ICON[stream.status] ?? { symbol: '?', color: 'white' }
  const delta = prev ? stream.record_count - prev.record_count : 0
  const deltaStr = delta > 0 ? ` (+${delta})` : ''
  const showCount = stream.record_count > 0 || stream.status === 'completed'

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={icon.color}>{icon.symbol} </Text>
        <Text>{name}</Text>
        {showCount && (
          <Text dimColor>: {stream.record_count} records{deltaStr}</Text>
        )}
      </Box>
      {errorMsg && (
        <Box marginLeft={3}>
          <Text color="red">{errorMsg}</Text>
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
  const cpDelta = prev ? progress.global_state_count - prev.global_state_count : 0
  const cpDeltaStr = cpDelta > 0 ? ` (+${cpDelta})` : ''

  // Global error (not attributable to a single stream)
  const errMsg = progress.connection_status?.status === 'failed'
    ? (progress.connection_status.message ?? 'Connection failed')
    : undefined
  const erroredStreams = streamEntries.filter(([, s]) => s.status === 'errored')
  const globalErr = errMsg && erroredStreams.length !== 1 ? errMsg : undefined

  // Build stats parts
  const statsParts: string[] = []
  statsParts.push(`${totalRecords} records${recordDeltaStr} (${progress.derived.records_per_second.toFixed(1)}/s)`)
  if (progress.global_state_count > 0) {
    statsParts.push(`${progress.global_state_count} checkpoints${cpDeltaStr} (${progress.derived.states_per_second.toFixed(1)}/s)`)
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={statusColor} bold>{statusLabel}</Text>
        <Text dimColor> {total} streams ({streamSummary}) — {elapsed}s</Text>
        {globalErr && <Text color="red"> — {globalErr}</Text>}
      </Box>
      <Box>
        <Text dimColor>{statsParts.join(' | ')}</Text>
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

  const errMsg = progress.connection_status?.status === 'failed'
    ? (progress.connection_status.message ?? 'Connection failed')
    : undefined
  const erroredStreams = entries.filter(([, s]) => s.status === 'errored').map(([n]) => n)
  // Show error inline on stream row only if it's attributable to a single stream
  const inlineErr = errMsg && erroredStreams.length === 1 ? errMsg : undefined

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
            errorMsg={stream.status === 'errored' ? (stream.error ?? inlineErr) : undefined}
          />
        ))}
        {notStarted.length > 0 && (
          <Box>
            <Text color="gray">○ </Text>
            <Text dimColor>{notStarted.map(([n]) => n).join(', ')}</Text>
          </Box>
        )}
      </Box>
      {errMsg && erroredStreams.length !== 1 && (
        <Box marginTop={1}>
          <Text color="red">{errMsg}</Text>
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
