import type { Message, TraceMessage } from '@stripe/sync-protocol'
import { toRecordMessage, stateMsg } from '@stripe/sync-protocol'
import type { ResourceConfig } from './types.js'
import type { SegmentState, BackfillState } from './index.js'
import type { RateLimiter } from './rate-limiter.js'
import type { StripeClient } from './client.js'

const SKIPPABLE_ERROR_PATTERNS = [
  'only available in testmode',
  'not in live mode',
  'Must provide customer',
  'Must provide ',
  'Missing required param',
]

const DEFAULT_BACKFILL_CONCURRENCY = 200

// MARK: - Compact state (generative — O(concurrency) not O(total segments))

/**
 * Compact the mutable segment array into a BackfillState.
 * Only stores completed ranges (merged) and in-flight cursors.
 * Pending segments are derived from gaps on expand.
 */
export function compactState(
  segments: SegmentState[],
  range: { gte: number; lt: number },
  numSegments: number
): BackfillState {
  const completed: BackfillState['completed'] = []
  const inFlight: BackfillState['in_flight'] = []

  for (const seg of segments) {
    if (seg.status === 'complete') {
      const last = completed.at(-1)
      if (last && last.lt === seg.gte) {
        last.lt = seg.lt // merge adjacent completed
      } else {
        completed.push({ gte: seg.gte, lt: seg.lt })
      }
    } else if (seg.page_cursor) {
      inFlight.push({ gte: seg.gte, lt: seg.lt, page_cursor: seg.page_cursor })
    }
    // pending with null cursor → derived from gaps, not stored
  }

  return { range, num_segments: numSegments, completed, in_flight: inFlight }
}

/**
 * Reconstruct the full segment array from a BackfillState.
 * Completed and in-flight segments are restored directly.
 * Gaps become pending segments, split to match the original segment granularity.
 */
export function expandState(state: BackfillState): SegmentState[] {
  // Collect all occupied intervals sorted by gte
  type Interval = {
    gte: number
    lt: number
    status: 'complete' | 'pending'
    page_cursor: string | null
  }
  const occupied: Interval[] = [
    ...state.completed.map((r) => ({ ...r, status: 'complete' as const, page_cursor: null })),
    ...state.in_flight.map((r) => ({
      ...r,
      status: 'pending' as const,
      page_cursor: r.page_cursor,
    })),
  ].sort((a, b) => a.gte - b.gte)

  const segments: SegmentState[] = []
  let idx = 0
  let cursor = state.range.gte
  const segmentSize = Math.max(
    1,
    Math.ceil((state.range.lt - state.range.gte) / state.num_segments)
  )

  for (const interval of occupied) {
    // Fill gap before this interval with pending segments
    if (cursor < interval.gte) {
      for (const seg of splitRange(cursor, interval.gte, segmentSize, idx)) {
        segments.push(seg)
        idx++
      }
    }
    // Add the occupied interval itself
    segments.push({
      index: idx,
      gte: interval.gte,
      lt: interval.lt,
      page_cursor: interval.page_cursor,
      status: interval.status,
    })
    idx++
    cursor = interval.lt
  }

  // Fill trailing gap with pending segments
  if (cursor < state.range.lt) {
    for (const seg of splitRange(cursor, state.range.lt, segmentSize, idx)) {
      segments.push(seg)
      idx++
    }
  }

  return segments
}

/** Split a range into pending segments of approximately `segmentSize`. */
function splitRange(
  gte: number,
  lt: number,
  segmentSize: number,
  startIndex: number
): SegmentState[] {
  const segments: SegmentState[] = []
  let cursor = gte
  let idx = startIndex
  while (cursor < lt) {
    const end = Math.min(cursor + segmentSize, lt)
    segments.push({ index: idx, gte: cursor, lt: end, page_cursor: null, status: 'pending' })
    cursor = end
    idx++
  }
  return segments
}

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

// Fallback for accounts that don't expose `created` (e.g. platform accounts
// in test mode).  Stripe launched in 2011, so this is the earliest a real
// account could have been created.
const STRIPE_LAUNCH_TIMESTAMP = Math.floor(new Date('2011-01-01T00:00:00Z').getTime() / 1000)

async function getAccountCreatedTimestamp(client: StripeClient): Promise<number> {
  const account = await client.getAccount()
  return account.created ?? STRIPE_LAUNCH_TIMESTAMP
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
    segments.push({ index: i, gte, lt, page_cursor: null, status: 'pending' })
  }

  return segments
}

// MARK: - Segment pagination

async function* paginateSegment(opts: {
  listFn: NonNullable<ResourceConfig['listFn']>
  segment: SegmentState
  segments: SegmentState[]
  range: { gte: number; lt: number }
  numSegments: number
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
    range,
    numSegments,
    streamName,
    supportsLimit,
    backfillLimit,
    totalEmitted,
    rateLimiter,
  } = opts

  let pageCursor: string | null = segment.page_cursor
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
    const response = await listFn(params as Parameters<typeof listFn>[0])

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
    segment.page_cursor = hasMore ? pageCursor : null
    segment.status = hasMore ? 'pending' : 'complete'

    const allComplete = segments.every((s) => s.status === 'complete')
    yield stateMsg({
      stream: streamName,
      data: {
        page_cursor: null,
        status: allComplete ? 'complete' : 'pending',
        backfill: compactState(segments, range, numSegments),
      },
    })
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
    const response = await resourceConfig.listFn!(
      params as Parameters<NonNullable<typeof resourceConfig.listFn>>[0]
    )

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

    yield stateMsg({
      stream: streamName,
      data: {
        page_cursor: hasMore ? pageCursor : null,
        status: hasMore ? 'pending' : 'complete',
      },
    })
  }
}

// MARK: - Main entry point

export async function* listApiBackfill(opts: {
  catalog: { streams: Array<{ stream: { name: string }; backfill_limit?: number | undefined }> }
  state:
    | Record<
        string,
        {
          page_cursor: string | null
          status: string
          segments?: SegmentState[]
          backfill?: BackfillState
        }
      >
    | undefined
  registry: Record<string, ResourceConfig>
  client: StripeClient
  rateLimiter: RateLimiter
  backfillLimit?: number
  backfillConcurrency?: number
  drainQueue?: () => AsyncGenerator<Message>
}): AsyncGenerator<Message> {
  const {
    catalog,
    state,
    registry,
    client,
    rateLimiter,
    backfillLimit,
    backfillConcurrency = DEFAULT_BACKFILL_CONCURRENCY,
    drainQueue,
  } = opts

  let accountCreated: number | null = null

  for (const configuredStream of catalog.streams) {
    const stream = configuredStream.stream
    // Per-stream limit overrides global backfillLimit
    const streamBackfillLimit = configuredStream.backfill_limit ?? backfillLimit
    const resourceConfig = findConfigByTableName(registry, stream.name)
    if (!resourceConfig) {
      yield {
        type: 'trace',
        trace: {
          trace_type: 'error',
          error: {
            failure_type: 'config_error',
            message: `Unknown stream: ${stream.name}`,
            stream: stream.name,
          },
        },
      } satisfies TraceMessage
      continue
    }

    if (!resourceConfig.listFn) continue

    const streamState = state?.[stream.name]
    if (streamState?.status === 'complete') continue

    yield {
      type: 'trace',
      trace: {
        trace_type: 'stream_status',
        stream_status: { stream: stream.name, status: 'started' },
      },
    } satisfies TraceMessage

    try {
      // Parallel path: streams that support created filter
      if (resourceConfig.supportsCreatedFilter) {
        let segments: SegmentState[]
        let range: { gte: number; lt: number }
        let numSegments: number

        if (streamState?.backfill) {
          // Resume from compact backfill state
          segments = expandState(streamState.backfill)
          range = streamState.backfill.range
          numSegments = streamState.backfill.num_segments
        } else if (streamState?.segments) {
          // Legacy: resume from old segment array format
          segments = streamState.segments.map((s) => ({ ...s }))
          range = { gte: segments[0].gte, lt: segments[segments.length - 1].lt }
          numSegments = backfillConcurrency
        } else {
          // First run: fetch account creation date and build segments
          if (accountCreated === null) {
            accountCreated = await getAccountCreatedTimestamp(client)
          }
          const now = Math.floor(Date.now() / 1000)
          range = { gte: accountCreated, lt: now + 1 }
          numSegments = backfillConcurrency
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
              range,
              numSegments,
              streamName: stream.name,
              supportsLimit: resourceConfig.supportsLimit !== false,
              backfillLimit: streamBackfillLimit,
              totalEmitted,
              rateLimiter,
            })
          )

          yield* mergeAsync(generators, backfillConcurrency)
        }
      } else {
        // Sequential path: no created filter support
        const pageCursor: string | null = streamState?.page_cursor ?? null
        yield* sequentialBackfillStream({
          resourceConfig,
          streamName: stream.name,
          pageCursor,
          backfillLimit: streamBackfillLimit,
          rateLimiter,
          drainQueue,
        })
      }

      yield {
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: stream.name, status: 'complete' },
        },
      } satisfies TraceMessage
    } catch (err) {
      if (isSkippableError(err)) {
        yield {
          type: 'trace',
          trace: {
            trace_type: 'stream_status',
            stream_status: { stream: stream.name, status: 'complete' },
          },
        } satisfies TraceMessage
        continue
      }
      console.error({
        msg: 'Stripe list page failed',
        stream: stream.name,
        error: err instanceof Error ? err.message : String(err),
      })
      const isRateLimit = err instanceof Error && err.message.includes('Rate limit')
      yield {
        type: 'trace',
        trace: {
          trace_type: 'error',
          error: {
            failure_type: isRateLimit ? 'transient_error' : 'system_error',
            message: String(err),
            stream: stream.name,
            ...(err instanceof Error ? { stack_trace: err.stack } : {}),
          },
        },
      } satisfies TraceMessage
    }
  }
}
