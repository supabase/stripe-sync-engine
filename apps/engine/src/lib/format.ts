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
 * When `prev` is provided, shows deltas (e.g. "+50 rows") for streams
 * that changed since the last progress emission.
 *
 * Example:
 *   ◐ Syncing — 3.2s | 450 rows (140.6/s) | 5 checkpoints
 *     ● customers: 200 rows
 *     ◐ invoices: 250 rows (+50)
 *     ○ charges
 */
export function formatProgress(progress: ProgressPayload, prev?: ProgressPayload): string {
  const elapsed = (progress.elapsed_ms / 1000).toFixed(1)
  const streamEntries = Object.entries(progress.streams)
  const totalRows = streamEntries.reduce((sum, [, s]) => sum + s.record_count, 0)
  const rps = progress.derived.records_per_second.toFixed(1)
  const statusLabel =
    progress.derived.status === 'failed' ? '🔴 Sync failed' : '🔄 Syncing'

  const prevTotalRows = prev
    ? Object.values(prev.streams).reduce((sum, s) => sum + s.record_count, 0)
    : 0
  const rowDelta = prev ? totalRows - prevTotalRows : 0

  const parts: string[] = []
  parts.push(`${elapsed}s`)
  if (totalRows > 0) {
    const deltaStr = rowDelta > 0 ? ` (+${rowDelta})` : ''
    parts.push(`${totalRows} rows${deltaStr} (${rps}/s)`)
  }
  if (progress.global_state_count > 0) parts.push(`${progress.global_state_count} checkpoints`)

  const header = `${statusLabel} — ${parts.join(' | ')}`

  const lines: string[] = [header]
  for (const [name, s] of streamEntries) {
    const emoji = STATUS_EMOJI[s.status] ?? '?'
    const prevStream: StreamProgress | undefined = prev?.streams[name]
    const delta = prevStream ? s.record_count - prevStream.record_count : 0
    const count = s.record_count > 0 ? `: ${s.record_count} rows` : ''
    const deltaStr = delta > 0 ? ` (+${delta})` : ''
    lines.push(`  ${emoji} ${name}${count}${deltaStr}`)
  }

  if (progress.connection_status?.status === 'failed') {
    const errMsg = progress.connection_status.message ?? 'Connection failed'
    lines[0] = `${lines[0]} — ${errMsg}`
  }

  return lines.join('\n')
}
