import type { ConnectionStatusMessage, LogMessage, EofPayload } from '@stripe/sync-protocol'
import { createEngineMessageFactory, mergeAsync } from '@stripe/sync-protocol'

const engineMsg = createEngineMessageFactory()
import { bindLogContext, createAsyncQueue, type RoutedLogEntry } from '@stripe/sync-logger'
import { log } from '../logger.js'

export function syncRequestContext(pipeline: {
  source: { type: string }
  destination: { type: string }
  streams?: Array<{ name: string }>
}) {
  return {
    sourceName: pipeline.source.type,
    destinationName: pipeline.destination.type,
    configuredStreamCount: pipeline.streams?.length ?? 0,
    configuredStreams: pipeline.streams?.map((stream) => stream.name) ?? [],
  }
}

export function errorMessages(err: unknown): [LogMessage, ConnectionStatusMessage] {
  const message =
    err instanceof Error
      ? err.message || (err as NodeJS.ErrnoException).code || err.constructor.name
      : String(err)
  return [
    engineMsg.log({ level: 'error', message }),
    { type: 'connection_status', connection_status: { status: 'failed', message } },
  ]
}

/**
 * Deep-clones the eof payload with every `completed_ranges` array removed.
 * These arrays are noisy in logs (often hundreds of entries per stream) but
 * still available on the raw message returned by the API.
 */
export function stripCompletedRanges<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stripCompletedRanges) as unknown as T
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value)) {
    if (key === 'completed_ranges') continue
    out[key] = stripCompletedRanges(val)
  }
  return out as T
}

export function formatEof(eof: EofPayload): string {
  const rp = eof.request_progress
  const elapsed = rp?.elapsed_ms ? `${(rp.elapsed_ms / 1000).toFixed(1)}s` : ''
  const rps = rp?.derived?.records_per_second?.toFixed(1) ?? '0'
  const states = rp?.global_state_count ?? 0

  const streamEntries = rp?.streams ? Object.entries(rp.streams) : []
  const totalRows = streamEntries.reduce((sum, [, s]) => sum + s.record_count, 0)

  const lines: string[] = []
  lines.push(
    `${eof.status === 'failed' ? 'Sync failed' : `has_more: ${eof.has_more}`}${elapsed ? ` (${elapsed}` : ''}${totalRows ? ` | ${totalRows} rows, ${rps} rows/s` : ''}${states ? `, ${states} checkpoints` : ''}${elapsed ? ')' : ''}`
  )

  if (streamEntries.length > 0) {
    for (const [name, s] of streamEntries) {
      if (s.record_count > 0) {
        lines.push(`  ✅ ${name}: ${s.record_count} rows`)
      }
    }
  }

  return lines.join('\n')
}

export async function* logApiStream<T>(
  label: string,
  iter: AsyncIterable<T>,
  context: Record<string, unknown>,
  startedAt = Date.now()
): AsyncIterable<T | LogMessage | ConnectionStatusMessage> {
  function toProtocolLog(entry: RoutedLogEntry): LogMessage {
    return engineMsg.log({
      level: entry.level,
      message: entry.message,
      ...(entry.data ? { data: entry.data } : {}),
    })
  }

  const logQueue = createAsyncQueue<LogMessage>()

  const main = bindLogContext(
    (async function* () {
      let itemCount = 0
      let hasError = false
      try {
        for await (const item of iter) {
          itemCount++
          const msg = item as {
            type?: string
            connection_status?: { status?: string }
            eof?: unknown
          }
          if (msg?.type === 'connection_status' && msg?.connection_status?.status === 'failed')
            hasError = true
          if (msg?.type === 'eof') {
              const eofPayload = msg.eof as EofPayload
              const eofLog = eofPayload.status === 'failed' ? log.error : log.info
              eofLog.call(log, { ...context, eof: eofPayload }, formatEof(eofPayload))
            }
          yield item
        }
        const summary = { ...context, itemCount, durationMs: Date.now() - startedAt }
        if (hasError) {
          log.error(summary, `${label} failed`)
        } else {
          log.debug(summary, `${label} completed`)
        }
      } catch (error) {
        log.error(
          { ...context, itemCount, durationMs: Date.now() - startedAt, err: error },
          `${label} failed`
        )
        if (!hasError) {
          const [logMsg, connMsg] = errorMessages(error)
          yield logMsg
          yield connMsg
        }
      } finally {
        logQueue.close()
      }
    })(),
    {
      onLog(entry) {
        logQueue.push(toProtocolLog(entry))
      },
    }
  )

  yield* mergeAsync([main, logQueue], 2)
}

/**
 * AbortController that fires when the HTTP client disconnects.
 *
 * Primary: `Request.signal` — standard Web API, works in Bun, Deno, and any
 * runtime that wires request lifetime to the signal.
 *
 * Fallback: `@hono/node-server` doesn't wire `Request.signal` to connection
 * close, so we also listen on the Node.js `ServerResponse` close event.
 *
 * Whichever fires first wins; `fireOnce` ensures the abort only happens once.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createConnectionAbort(c: any, onDisconnect?: () => void): AbortController {
  const ac = new AbortController()

  const fireOnce = () => {
    if (!ac.signal.aborted) {
      onDisconnect?.()
      ac.abort()
    }
  }

  // Standard: Request.signal aborts on client disconnect
  const reqSignal = c.req?.raw?.signal as AbortSignal | undefined
  if (reqSignal && !reqSignal.aborted) {
    reqSignal.addEventListener('abort', fireOnce, { once: true })
  }

  // Fallback: @hono/node-server exposes ServerResponse at c.env.outgoing
  const outgoing = c.env?.outgoing as import('node:http').ServerResponse | undefined
  if (outgoing && typeof outgoing.on === 'function') {
    outgoing.on('close', () => {
      if (outgoing.writableFinished === false) fireOnce()
    })
  }

  return ac
}

export async function* verboseInput(
  _label: string,
  iter: AsyncIterable<unknown>
): AsyncIterable<unknown> {
  yield* iter
}
