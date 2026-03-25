import type { LogSink } from '../stores.js'

/** Log sink that writes to stderr. Suitable for CLI usage. */
export function stderrLogSink(): LogSink {
  return {
    write(_syncId, entry) {
      const prefix = entry.stream ? `[${entry.level}:${entry.stream}]` : `[${entry.level}]`
      console.error(`${prefix} ${entry.message}`)
    },
  }
}
