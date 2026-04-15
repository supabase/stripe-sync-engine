import type { Message, TraceMessage } from '@stripe/sync-protocol'
import { toRecordMessage, stateMsg } from '@stripe/sync-protocol'
import type { ListFn, ListResult } from '@stripe/sync-openapi'
import type { ResourceConfig } from './types.js'
import type { SegmentState, BackfillState } from './index.js'
import type { RateLimiter } from './rate-limiter.js'
import { MAX_SEGMENTS, MAX_CONCURRENCY } from './rate-limiter.js'
import { StripeApiRequestError } from '@stripe/sync-openapi'
import type { StripeClient } from './client.js'

// MARK: - Rate-limit wrapper

function waitForRateLimit(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason)
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      reject(signal!.reason)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function withRateLimit(listFn: ListFn, rateLimiter: RateLimiter, signal?: AbortSignal): ListFn {
  return async (params) => {
    const wait = await rateLimiter()
    if (wait > 0) await waitForRateLimit(wait * 1000, signal)
    return listFn(params)
  }
}

export function getFailureType(err: unknown): 'transient_error' | 'system_error' | 'auth_error' {
  const isRateLimit = err instanceof Error && err.message.includes('Rate limit')
  const isAuth = err instanceof StripeApiRequestError && (err.status === 401 || err.status === 403)
  return isRateLimit ? 'transient_error' : isAuth ? 'auth_error' : 'system_error'
}

export function errorToTrace(err: unknown, stream: string): TraceMessage {
  return {
    type: 'trace',
    trace: {
      trace_type: 'error',
      error: {
        failure_type: getFailureType(err),
        message: err instanceof Error ? err.message : String(err),
        stream,
        ...(err instanceof Error ? { stack_trace: err.stack } : {}),
      },
    },
  }
}

// Errors matching these patterns are silently skipped during backfill.
// The stream is marked complete without yielding records.
// NOTE: these are band-aids — the underlying issue is that the OpenAPI spec
// advertises endpoints that don't exist for all accounts/key types (e.g.
// /v1/exchange_rates). This means pipeline_setup creates empty tables in
// Postgres that never get populated. The proper fix is to filter unreachable
// endpoints during discover or to not create tables for streams that fail.
//
// Examples of matched errors:
//   400 "This resource is only available in testmode."          → only available in testmode
//   400 "This endpoint is not in live mode"                     → not in live mode
//   400 "Must provide customer"                                 → Must provide customer
//   400 "Must provide source or customer"                       → Must provide
//   400 "This API surface is not enabled for testmode usage."   → not enabled for
//   400 "Accounts v2 is not enabled for your platform."         → not enabled for
//   400 "Your account is not set up to use Issuing."            → not set up to use
const SKIPPABLE_ERROR_PATTERNS = [
  'only available in testmode',
  'not in live mode',
  'not enabled for',
  'Must provide customer',
  'Must provide ',
  'not set up to use',
]

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
  numSegments: number
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

// MARK: - Density probe + segment construction

/**
 * Smooth mapping from density to segment count. `timeProgress` is the fraction
 * of the backfill time range covered by the first 100 items. The inverse
 * relationship avoids the cliff edges of discrete tiers.
 */
export function segmentCountFromDensity(timeProgress: number): number {
  if (timeProgress <= 0) return MAX_SEGMENTS
  return Math.max(1, Math.min(MAX_SEGMENTS, Math.ceil(1 / timeProgress)))
}

/**
 * Probe data density with a single list call, then build the segment array.
 * The probe fetches with a `created` filter (forward-compatible if the range
 * narrows later) and returns its response so the caller can yield the records
 * directly — zero wasted API calls.
 *
 * Stripe returns data in descending `created` order. If 100 items span a
 * large fraction of the time range the resource is sparse and fewer segments
 * suffice; if they cluster in a narrow window the resource is dense and more
 * segments help parallelise.
 */
export async function probeAndBuildSegments(opts: {
  listFn: ListFn
  range: { gte: number; lt: number }
}): Promise<{ segments: SegmentState[]; numSegments: number; firstPage: ListResult }> {
  const { listFn, range } = opts

  const firstPage = await listFn({
    limit: 100,
    created: { gte: range.gte, lt: range.lt },
  })

  if (!firstPage.has_more) {
    return {
      segments: [{ index: 0, gte: range.gte, lt: range.lt, page_cursor: null, status: 'pending' }],
      numSegments: 1,
      firstPage,
    }
  }

  const lastItem = firstPage.data[firstPage.data.length - 1] as { created?: number }
  const totalSpan = range.lt - range.gte
  if (totalSpan <= 0) {
    return {
      segments: [{ index: 0, gte: range.gte, lt: range.lt, page_cursor: null, status: 'pending' }],
      numSegments: 1,
      firstPage,
    }
  }

  const timeProgress = (range.lt - (lastItem?.created ?? range.gte)) / totalSpan
  const numSegments = segmentCountFromDensity(timeProgress)
  const segments = buildSegments(range.gte, range.lt - 1, numSegments)

  return { segments, numSegments, firstPage }
}

// MARK: - Segment pagination

async function* paginateSegment(opts: {
  listFn: ListFn
  segment: SegmentState
  segments: SegmentState[]
  range: { gte: number; lt: number }
  numSegments: number
  streamName: string
  accountId: string
  supportsLimit: boolean
  supportsForwardPagination: boolean
  backfillLimit?: number
  totalEmitted: { count: number }
}): AsyncGenerator<Message> {
  const {
    listFn,
    segment,
    segments,
    range,
    numSegments,
    streamName,
    accountId,
    supportsLimit,
    supportsForwardPagination,
    backfillLimit,
    totalEmitted,
  } = opts

  let pageCursor: string | null = segment.page_cursor
  let hasMore = true

  while (hasMore) {
    const params: Record<string, unknown> = {
      created: { gte: segment.gte, lt: segment.lt },
    }
    if (supportsForwardPagination && supportsLimit !== false) {
      params.limit = 100
    }
    if (supportsForwardPagination && pageCursor) {
      params.starting_after = pageCursor
    }

    const response = await listFn(params as Parameters<typeof listFn>[0])

    for (const item of response.data) {
      yield toRecordMessage(streamName, {
        ...(item as Record<string, unknown>),
        _account_id: accountId,
      })
      totalEmitted.count++
    }

    hasMore = supportsForwardPagination && response.has_more
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
  resourceConfig: ResourceConfig & { listFn: ListFn }
  streamName: string
  accountId: string
  pageCursor: string | null
  backfillLimit?: number
  drainQueue?: () => AsyncGenerator<Message>
}): AsyncGenerator<Message> {
  const { resourceConfig, streamName, accountId, backfillLimit, drainQueue } = opts
  let pageCursor = opts.pageCursor
  let hasMore = true
  let totalEmitted = 0

  while (hasMore) {
    if (drainQueue) yield* drainQueue()

    const params: Record<string, unknown> = {}
    // `!== false` treats undefined as "supports pagination" for backward compat.
    if (
      resourceConfig.supportsForwardPagination !== false &&
      resourceConfig.supportsLimit !== false
    ) {
      params.limit = 100
    }
    if (resourceConfig.supportsForwardPagination !== false && pageCursor) {
      params.starting_after = pageCursor
    }

    const response = await resourceConfig.listFn(
      params as Parameters<typeof resourceConfig.listFn>[0]
    )

    for (const item of response.data) {
      yield toRecordMessage(streamName, {
        ...(item as Record<string, unknown>),
        _account_id: accountId,
      })
      totalEmitted++
    }

    hasMore = resourceConfig.supportsForwardPagination !== false && response.has_more
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
  accountId: string
  rateLimiter: RateLimiter
  backfillLimit?: number
  drainQueue?: () => AsyncGenerator<Message>
  signal?: AbortSignal
}): AsyncGenerator<Message> {
  const { catalog, state, registry, client, accountId, rateLimiter, backfillLimit, drainQueue } =
    opts

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
      yield stateMsg({
        stream: stream.name,
        data: { page_cursor: null, status: 'config_error' },
      })
      continue
    }

    if (!resourceConfig.listFn) continue

    const streamState = state?.[stream.name]
    const streamStatus = streamState?.status
    if (
      streamStatus === 'complete' ||
      streamStatus === 'system_error' ||
      streamStatus === 'config_error' ||
      streamStatus === 'auth_error'
    )
      continue

    yield {
      type: 'trace',
      trace: {
        trace_type: 'stream_status',
        stream_status: { stream: stream.name, status: 'started' },
      },
    } satisfies TraceMessage

    try {
      const rateLimitedListFn = withRateLimit(resourceConfig.listFn!, rateLimiter, opts.signal)

      // Parallel path: streams that support created filter
      if (resourceConfig.supportsCreatedFilter) {
        let segments: SegmentState[]
        let range: { gte: number; lt: number }
        let numSegments: number
        let firstPage: ListResult | null = null

        if (streamState?.backfill) {
          // Resume from compact backfill state
          segments = expandState(streamState.backfill)
          range = streamState.backfill.range
          numSegments = streamState.backfill.num_segments
        } else if (streamState?.segments) {
          // Legacy: resume from old segment array format
          segments = streamState.segments.map((s) => ({ ...s }))
          range = { gte: segments[0].gte, lt: segments[segments.length - 1].lt }
          numSegments = segments.length
        } else {
          // First run: probe density and build segments in one call
          if (accountCreated === null) {
            accountCreated = await getAccountCreatedTimestamp(client)
          }
          const now = Math.floor(Date.now() / 1000)
          range = { gte: accountCreated, lt: now + 1 }
          const probe = await probeAndBuildSegments({
            listFn: rateLimitedListFn,
            range,
          })
          segments = probe.segments
          numSegments = probe.numSegments
          firstPage = probe.firstPage
        }

        const incompleteSegments = segments.filter((s) => s.status !== 'complete')
        if (incompleteSegments.length > 0) {
          const totalEmitted = { count: 0 }

          // For single-segment streams, yield probe data directly (zero waste).
          // Multi-segment streams skip this because the probe fetches newest-first
          // across the full range, and attributing those items to a specific segment
          // would cause cursor/range mismatches during pagination.
          if (firstPage && firstPage.data.length > 0 && numSegments === 1) {
            const onlySegment = incompleteSegments[0]
            for (const item of firstPage.data) {
              yield toRecordMessage(stream.name, {
                ...(item as Record<string, unknown>),
                _account_id: accountId,
              })
              totalEmitted.count++
            }
            if (firstPage.has_more) {
              const lastId = (firstPage.data[firstPage.data.length - 1] as { id: string }).id
              onlySegment.page_cursor = lastId
            } else {
              onlySegment.status = 'complete'
            }
            const allComplete = segments.every((s) => s.status === 'complete')
            yield stateMsg({
              stream: stream.name,
              data: {
                page_cursor: null,
                status: allComplete ? 'complete' : 'pending',
                backfill: compactState(segments, range, numSegments),
              },
            })
          }

          const stillIncomplete = segments.filter((s) => s.status !== 'complete')
          const generators = stillIncomplete.map((segment) =>
            paginateSegment({
              listFn: rateLimitedListFn,
              segment,
              segments,
              range,
              numSegments,
              streamName: stream.name,
              accountId,
              supportsLimit: resourceConfig.supportsLimit !== false,
              supportsForwardPagination: resourceConfig.supportsForwardPagination !== false,
              backfillLimit: streamBackfillLimit,
              totalEmitted,
            })
          )

          yield* mergeAsync(generators, MAX_CONCURRENCY)
        }
      } else {
        // Sequential path: no created filter support
        const pageCursor: string | null = streamState?.page_cursor ?? null
        yield* sequentialBackfillStream({
          resourceConfig: { ...resourceConfig, listFn: rateLimitedListFn },
          streamName: stream.name,
          accountId,
          pageCursor,
          backfillLimit: streamBackfillLimit,
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
      const failureType = getFailureType(err)
      yield errorToTrace(err, stream.name)
      yield stateMsg({
        stream: stream.name,
        data: {
          page_cursor: streamState?.page_cursor ?? null,
          status: failureType,
          ...(streamState?.backfill ? { backfill: streamState.backfill } : {}),
        },
      })
    }
  }
}
