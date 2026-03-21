import type {
  ErrorMessage,
  Message,
  StateMessage,
  StreamStatusMessage,
} from '@stripe/sync-protocol'
import { toRecordMessage } from '@stripe/sync-protocol'
import type { ResourceConfig } from './types'

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
  drainQueue?: () => AsyncGenerator<Message>
}): AsyncGenerator<Message> {
  const { catalog, state, registry, drainQueue } = opts

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
      while (hasMore) {
        // Drain any queued events before each page
        if (drainQueue) yield* drainQueue()

        const params: { limit: number; starting_after?: string } = { limit: 100 }
        if (pageCursor) {
          params.starting_after = pageCursor
        }

        const response = await resourceConfig.listFn(params)

        for (const item of response.data) {
          yield toRecordMessage(stream.name, item as Record<string, unknown>)
        }

        hasMore = response.has_more
        if (response.data.length > 0) {
          pageCursor = (response.data[response.data.length - 1] as { id: string }).id
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
