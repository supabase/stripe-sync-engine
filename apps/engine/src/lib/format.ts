import type { ProgressPayload } from '@stripe/sync-protocol'

const STATUS_EMOJI: Record<string, string> = {
  not_started: '⏳',
  started: '🔄',
  completed: '✅',
  skipped: '⏭️',
  errored: '❌',
}

/**
 * Format a ProgressPayload into a human-readable string for CLI output.
 *
 * Example:
 *   🔄 Syncing — 3.2s | 450 rows (141 rows/s) | 2 checkpoints
 *     ✅ customers: 200 rows
 *     🔄 invoices: 250 rows
 *     ⏳ charges
 */
export function formatProgress(progress: ProgressPayload): string {
  const elapsed = (progress.elapsed_ms / 1000).toFixed(1)
  const streamEntries = Object.entries(progress.streams)
  const totalRows = streamEntries.reduce((sum, [, s]) => sum + s.record_count, 0)
  const rps = progress.derived.records_per_second.toFixed(1)
  const statusEmoji = progress.derived.status === 'failed' ? '❌' : '🔄'

  const parts: string[] = []
  parts.push(`${elapsed}s`)
  if (totalRows > 0) parts.push(`${totalRows} rows (${rps}/s)`)
  if (progress.global_state_count > 0) parts.push(`${progress.global_state_count} checkpoints`)

  const header = `${statusEmoji} Syncing — ${parts.join(' | ')}`

  const lines: string[] = [header]
  for (const [name, s] of streamEntries) {
    const emoji = STATUS_EMOJI[s.status] ?? '❓'
    const count = s.record_count > 0 ? `: ${s.record_count} rows` : ''
    lines.push(`  ${emoji} ${name}${count}`)
  }

  if (progress.connection_status?.status === 'failed') {
    lines.push(`  ⚠️  ${progress.connection_status.message ?? 'Connection failed'}`)
  }

  return lines.join('\n')
}
