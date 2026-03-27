import type {
  ErrorMessage,
  Message,
  StateMessage,
  StreamStatusMessage,
} from '@stripe/sync-protocol'
import { toRecordMessage } from '@stripe/sync-protocol'
import type { ResourceConfig } from './types.js'

const SKIPPABLE_ERROR_PATTERNS = [
  'only available in testmode',
  'not in live mode',
  'Must provide customer',
  'Must provide ',
  'Missing required param',
]

function isSkippableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return SKIPPABLE_ERROR_PATTERNS.some((p) => msg.includes(p))
}

function findConfigByTableName(
  registry: Record<string, ResourceConfig>,
  tableName: string
): ResourceConfig | undefined {
  return Object.values(registry).find((cfg) => cfg.tableName === tableName)
}

export async function* listApiBackfill(opts: {
  catalog: { streams: Array<{ stream: { name: string } }> }
  state: Record<string, { pageCursor: string | null; status: string }> | undefined
  registry: Record<string, ResourceConfig>
  backfillLimit?: number
  drainQueue?: () => AsyncGenerator<Message>
}): AsyncGenerator<Message> {
  const { catalog, state, registry, backfillLimit, drainQueue } = opts

  for (const configuredStream of catalog.streams) {
    const stream = configuredStream.stream
    const resourceConfig = findConfigByTableName(registry, stream.name)
    if (!resourceConfig) {
      yield {
        type: 'error',
        failure_type: 'config_error',
        message: `Unknown stream: ${stream.name}`,
        stream: stream.name,
      } satisfies ErrorMessage
      continue
    }

    if (!resourceConfig.listFn) continue

    // Skip already-complete streams (e.g. resuming after full backfill for events polling)
    const streamState = state?.[stream.name]
    if (streamState?.status === 'complete') continue

    yield {
      type: 'stream_status',
      stream: stream.name,
      status: 'started',
    } satisfies StreamStatusMessage

    // Restore cursor from combined state if available
    let pageCursor: string | null = streamState?.pageCursor ?? null

    try {
      let hasMore = true
      let totalEmitted = 0
      while (hasMore) {
        // Drain any queued events before each page
        if (drainQueue) yield* drainQueue()

        const params: Record<string, unknown> = {}
        if (resourceConfig.supportsLimit !== false) {
          params.limit = 100
        }
        if (pageCursor) {
          params.starting_after = pageCursor
        }

        // TODO: replace with structured logger once one is wired into the source connector;
        // console.error (stderr) is used here intentionally — console.log/info would write
        // to stdout and corrupt the NDJSON output stream.
        console.error({
          msg: 'Starting Stripe list page',
          stream: stream.name,
          pageCursor,
        })
        const response = await resourceConfig.listFn(
          params as Parameters<typeof resourceConfig.listFn>[0]
        )
        console.error({
          msg: 'Completed Stripe list page',
          stream: stream.name,
          pageCursor,
          recordCount: response.data.length,
          hasMore: response.has_more,
        })

        for (const item of response.data) {
          yield toRecordMessage(stream.name, item as Record<string, unknown>)
          totalEmitted++
        }

        hasMore = response.has_more
        if (response.pageCursor) {
          pageCursor = response.pageCursor
        } else if (response.data.length > 0) {
          pageCursor = (response.data[response.data.length - 1] as { id: string }).id
        }

        // Stop early if backfill limit reached
        if (backfillLimit && totalEmitted >= backfillLimit) {
          hasMore = false
        }

        // Emit state checkpoint after each page
        yield {
          type: 'state',
          stream: stream.name,
          data: {
            pageCursor: hasMore ? pageCursor : null,
            status: hasMore ? 'pending' : 'complete',
          },
        } satisfies StateMessage
      }

      yield {
        type: 'stream_status',
        stream: stream.name,
        status: 'complete',
      } satisfies StreamStatusMessage
    } catch (err) {
      if (isSkippableError(err)) {
        yield {
          type: 'stream_status',
          stream: stream.name,
          status: 'complete',
        } satisfies StreamStatusMessage
        continue
      }
      console.error({
        msg: 'Stripe list page failed',
        stream: stream.name,
        pageCursor,
        error: err instanceof Error ? err.message : String(err),
      })
      const isRateLimit = err instanceof Error && err.message.includes('Rate limit')
      yield {
        type: 'error',
        failure_type: isRateLimit ? 'transient_error' : 'system_error',
        message: String(err),
        stream: stream.name,
        ...(err instanceof Error ? { stack_trace: err.stack } : {}),
      } satisfies ErrorMessage
    }
  }
}
