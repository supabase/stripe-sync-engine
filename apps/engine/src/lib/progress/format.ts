import type { ProgressPayload, StreamProgress } from '@stripe/sync-protocol'

const STATUS_EMOJI: Record<string, string> = {
  not_started: '⚪',
  started: '🟡',
  completed: '🟢',
  skipped: '⏭️',
  errored: '🔴',
}

/**
 * Format a ProgressPayload into a human-readable string for CLI output.
 * When `prev` is provided, shows deltas since last emission.
 *
 * Only shows active/completed/errored streams individually. Not-started
 * streams are collapsed into a count.
 */
export function formatProgress(progress: ProgressPayload, prev?: ProgressPayload): string {
  const elapsed = (progress.elapsed_ms / 1000).toFixed(1)
  const streamEntries = Object.entries(progress.streams)
  const totalRecords = streamEntries.reduce((sum, [, s]) => sum + s.record_count, 0)
  // Count streams by status
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

  const total = streamEntries.length
  const statusLabel =
    progress.derived.status === 'failed' ? `🔴 Sync failed (${total} streams)`
    : progress.derived.status === 'succeeded' ? `✅ Sync complete (${total} streams)`
    : `🔄 Syncing ${total} streams`

  const prevTotalRecords = prev
    ? Object.values(prev.streams).reduce((sum, s) => sum + s.record_count, 0)
    : 0
  const recordDelta = prev ? totalRecords - prevTotalRecords : 0

  const parts: string[] = []
  parts.push(`${elapsed}s`)
  if (totalRecords > 0) {
    const deltaStr = recordDelta > 0 ? ` (+${recordDelta})` : ''
    parts.push(`${totalRecords} records${deltaStr} (${progress.derived.records_per_second.toFixed(1)}/s)`)
  }
  if (progress.global_state_count > 0) {
    const cpDelta = prev ? progress.global_state_count - prev.global_state_count : 0
    const cpDeltaStr = cpDelta > 0 ? ` (+${cpDelta})` : ''
    parts.push(`${progress.global_state_count} checkpoints${cpDeltaStr} (${progress.derived.states_per_second.toFixed(1)}/s)`)
  }

  const header = `${statusLabel} — ${parts.join(' | ')} — ${streamSummary}`

  const errMsg = progress.connection_status?.status === 'failed'
    ? (progress.connection_status.message ?? 'Connection failed')
    : undefined
  const erroredStreams = streamEntries.filter(([, s]) => s.status === 'errored').map(([n]) => n)

  const visible = streamEntries.filter(([, s]) => s.status !== 'not_started')
  const notStartedCount = streamEntries.length - visible.length

  const lines: string[] = [header]
  for (const [name, s] of visible) {
    const emoji = STATUS_EMOJI[s.status] ?? '?'
    const prevStream: StreamProgress | undefined = prev?.streams[name]
    const delta = prevStream ? s.record_count - prevStream.record_count : 0
    const count = s.record_count > 0 || s.status === 'completed' ? `: ${s.record_count} records` : ''
    const deltaStr = delta > 0 ? ` (+${delta})` : ''
    const streamErr = s.status === 'errored' && errMsg && erroredStreams.length === 1 ? ` — ${errMsg}` : ''
    lines.push(`  ${emoji} ${name}${count}${deltaStr}${streamErr}`)
  }
  if (notStartedCount > 0) {
    const notStartedNames = streamEntries.filter(([, s]) => s.status === 'not_started').map(([n]) => n)
    lines.push(`  ⚪ ${notStartedNames.join(', ')}`)
  }

  // Global error (not attributable to a single stream)
  if (errMsg && erroredStreams.length !== 1) {
    lines[0] = `${lines[0]} — ${errMsg}`
  }

  return lines.join('\n')
}
