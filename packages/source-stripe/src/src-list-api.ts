import type {
  ErrorMessage,
  Message,
  StateMessage,
  StreamStatusMessage,
} from '@stripe/sync-protocol'
import { toRecordMessage } from '@stripe/sync-protocol'
import type { ResourceConfig } from './types.js'
import type { SegmentState } from './index.js'
import type { RateLimiter } from './rate-limiter.js'
import type Stripe from 'stripe'

const SKIPPABLE_ERROR_PATTERNS = [
  'only available in testmode',
  'not in live mode',
  'Must provide customer',
  'Must provide ',
  'Missing required param',
]

const DEFAULT_BACKFILL_CONCURRENCY = 200

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

// MARK: - mergeAsync

type IndexedResult<T> = { index: number; result: IteratorResult<T, undefined> }

async function* mergeAsync<T>(
  generators: AsyncGenerator<T>[],
  concurrency: number
): AsyncGenerator<T> {
  const active = new Map<number, Promise<IndexedResult<T>>>()
  let nextIndex = 0

  function pull(gen: AsyncGenerator<T>, index: number) {
    active.set(
      index,
      gen.next().then((result) => ({ index, result: result as IteratorResult<T, undefined> }))
    )
  }

  const limit = Math.min(concurrency, generators.length)
  for (let i = 0; i < limit; i++) {
    pull(generators[i], i)
    nextIndex = i + 1
  }

  while (active.size > 0) {
    const { index, result } = await Promise.race(active.values())
    active.delete(index)

    if (result.done) {
      if (nextIndex < generators.length) {
        pull(generators[nextIndex], nextIndex)
        nextIndex++
      }
    } else {
      yield result.value
      pull(generators[index], index)
    }
  }
}

// MARK: - Account created timestamp

async function getAccountCreatedTimestamp(stripe: Stripe): Promise<number> {
  const account = await stripe.accounts.retrieve()
  return account.created ?? 1293840000
}

// MARK: - Segment creation

function buildSegments(
  startTimestamp: number,
  endTimestamp: number,
  numSegments = DEFAULT_BACKFILL_CONCURRENCY
): SegmentState[] {
  const range = endTimestamp - startTimestamp
  const segmentSize = Math.max(1, Math.ceil(range / numSegments))
  const segments: SegmentState[] = []

  for (let i = 0; i < numSegments; i++) {
    const gte = startTimestamp + i * segmentSize
    const lt = i === numSegments - 1 ? endTimestamp + 1 : startTimestamp + (i + 1) * segmentSize
    if (gte >= endTimestamp + 1) break
    segments.push({ index: i, gte, lt, pageCursor: null, status: 'pending' })
  }

  return segments
}

// MARK: - Segment pagination

async function* paginateSegment(opts: {
  listFn: NonNullable<ResourceConfig['listFn']>
  segment: SegmentState
  segments: SegmentState[]
  streamName: string
  supportsLimit: boolean
  backfillLimit?: number
  totalEmitted: { count: number }
  rateLimiter: RateLimiter
}): AsyncGenerator<Message> {
  const {
    listFn,
    segment,
    segments,
    streamName,
    supportsLimit,
    backfillLimit,
    totalEmitted,
    rateLimiter,
  } = opts

  let pageCursor: string | null = segment.pageCursor
  let hasMore = true

  while (hasMore) {
    const params: Record<string, unknown> = {
      created: { gte: segment.gte, lt: segment.lt },
    }
    if (supportsLimit !== false) {
      params.limit = 100
    }
    if (pageCursor) {
      params.starting_after = pageCursor
    }

    const wait = await rateLimiter()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000))
    console.error({
      msg: 'Starting Stripe list page',
      stream: streamName,
      segment: segment.index,
      pageCursor,
      created: params.created,
    })
    const response = await listFn(params as Parameters<typeof listFn>[0])
    console.error({
      msg: 'Completed Stripe list page',
      stream: streamName,
      segment: segment.index,
      pageCursor,
      recordCount: response.data.length,
      hasMore: response.has_more,
    })

    for (const item of response.data) {
      yield toRecordMessage(streamName, item as Record<string, unknown>)
      totalEmitted.count++
    }

    hasMore = response.has_more
    if (response.pageCursor) {
      pageCursor = response.pageCursor
    } else if (response.data.length > 0) {
      pageCursor = (response.data[response.data.length - 1] as { id: string }).id
    }

    if (backfillLimit && totalEmitted.count >= backfillLimit) {
      hasMore = false
    }

    // Update shared segment state and emit checkpoint
    segment.pageCursor = hasMore ? pageCursor : null
    segment.status = hasMore ? 'pending' : 'complete'

    const allComplete = segments.every((s) => s.status === 'complete')
    yield {
      type: 'state',
      stream: streamName,
      data: {
        pageCursor: null,
        status: allComplete ? 'complete' : 'pending',
        segments: segments.map((s) => ({ ...s })),
      },
    } satisfies StateMessage
  }
}

// MARK: - Sequential fallback (original logic)

async function* sequentialBackfillStream(opts: {
  resourceConfig: ResourceConfig
  streamName: string
  pageCursor: string | null
  backfillLimit?: number
  rateLimiter: RateLimiter
  drainQueue?: () => AsyncGenerator<Message>
}): AsyncGenerator<Message> {
  const { resourceConfig, streamName, backfillLimit, rateLimiter, drainQueue } = opts
  let pageCursor = opts.pageCursor
  let hasMore = true
  let totalEmitted = 0

  while (hasMore) {
    if (drainQueue) yield* drainQueue()

    const params: Record<string, unknown> = {}
    if (resourceConfig.supportsLimit !== false) {
      params.limit = 100
    }
    if (pageCursor) {
      params.starting_after = pageCursor
    }

    const wait = await rateLimiter()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000))
    console.error({
      msg: 'Starting Stripe list page',
      stream: streamName,
      pageCursor,
    })
    const response = await resourceConfig.listFn!(
      params as Parameters<NonNullable<typeof resourceConfig.listFn>>[0]
    )
    console.error({
      msg: 'Completed Stripe list page',
      stream: streamName,
      pageCursor,
      recordCount: response.data.length,
      hasMore: response.has_more,
    })

    for (const item of response.data) {
      yield toRecordMessage(streamName, item as Record<string, unknown>)
      totalEmitted++
    }

    hasMore = response.has_more
    if (response.pageCursor) {
      pageCursor = response.pageCursor
    } else if (response.data.length > 0) {
      pageCursor = (response.data[response.data.length - 1] as { id: string }).id
    }

    if (backfillLimit && totalEmitted >= backfillLimit) {
      hasMore = false
    }

    yield {
      type: 'state',
      stream: streamName,
      data: {
        pageCursor: hasMore ? pageCursor : null,
        status: hasMore ? 'pending' : 'complete',
      },
    } satisfies StateMessage
  }
}

// MARK: - Main entry point

export async function* listApiBackfill(opts: {
  catalog: { streams: Array<{ stream: { name: string } }> }
  state:
    | Record<string, { pageCursor: string | null; status: string; segments?: SegmentState[] }>
    | undefined
  registry: Record<string, ResourceConfig>
  stripe: Stripe
  rateLimiter: RateLimiter
  backfillLimit?: number
  backfillConcurrency?: number
  drainQueue?: () => AsyncGenerator<Message>
}): AsyncGenerator<Message> {
  const {
    catalog,
    state,
    registry,
    stripe,
    rateLimiter,
    backfillLimit,
    backfillConcurrency = DEFAULT_BACKFILL_CONCURRENCY,
    drainQueue,
  } = opts

  let accountCreated: number | null = null

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

    const streamState = state?.[stream.name]
    if (streamState?.status === 'complete') continue

    yield {
      type: 'stream_status',
      stream: stream.name,
      status: 'started',
    } satisfies StreamStatusMessage

    try {
      // Parallel path: streams that support created filter
      if (resourceConfig.supportsCreatedFilter) {
        let segments: SegmentState[]

        if (streamState?.segments) {
          // Resume from prior segment state — only run incomplete segments
          segments = streamState.segments.map((s) => ({ ...s }))
        } else {
          // First run: fetch account creation date and build segments
          if (accountCreated === null) {
            accountCreated = await getAccountCreatedTimestamp(stripe)
          }
          const now = Math.floor(Date.now() / 1000)
          segments = buildSegments(accountCreated, now, backfillConcurrency)
        }

        const incompleteSegments = segments.filter((s) => s.status !== 'complete')
        if (incompleteSegments.length > 0) {
          const totalEmitted = { count: 0 }
          const generators = incompleteSegments.map((segment) =>
            paginateSegment({
              listFn: resourceConfig.listFn!,
              segment,
              segments,
              streamName: stream.name,
              supportsLimit: resourceConfig.supportsLimit !== false,
              backfillLimit,
              totalEmitted,
              rateLimiter,
            })
          )

          yield* mergeAsync(generators, backfillConcurrency)
        }
      } else {
        // Sequential path: no created filter support
        const pageCursor: string | null = streamState?.pageCursor ?? null
        yield* sequentialBackfillStream({
          resourceConfig,
          streamName: stream.name,
          pageCursor,
          backfillLimit,
          rateLimiter,
          drainQueue,
        })
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
