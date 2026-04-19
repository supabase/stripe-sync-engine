import type { Message } from '@stripe/sync-protocol'
import {
  nextStep,
  toUnixSeconds,
  toIso,
  mergeAsync,
} from '@stripe/sync-protocol'
import type { ListFn } from '@stripe/sync-openapi'
import type { ResourceConfig } from './types.js'
import type { RemainingRange, StreamState } from './index.js'
import { msg } from './index.js'
import type { RateLimiter } from './rate-limiter.js'
import { StripeApiRequestError } from '@stripe/sync-openapi'
import type { StripeClient } from './client.js'
import { STRIPE_LAUNCH_TIMESTAMP } from './account-metadata.js'

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

// MARK: - Error helpers

/** Convert an error to a connection_status: failed message. */
export function errorToConnectionStatus(err: unknown): Message {
  return msg.connection_status({
    status: 'failed',
    message: err instanceof Error ? err.message : String(err),
  })
}

/**
 * Each pattern catches exactly one known permanent error for one stream.
 * Prefer false negatives (failing to skip) over false positives (accidentally
 * skipping a real error). When a new permanent error is discovered, add a new
 * entry with a comment naming the exact stream and the full raw error message.
 */
const SKIPPABLE_ERROR_MESSAGES = [
  // forwarding_requests
  // "Your account is not authorized to send Forwarding requests in livemode. To enable access,
  //  please contact us via https://support.stripe.com/contact. [GET /v1/forwarding/requests (400)]
  //  {request-id=req_BJBACn1FDAJcUM}"
  'Your account is not authorized to send Forwarding requests in livemode',

  // test_helpers_test_clocks
  // "This endpoint is only available in testmode. Try using your test keys instead.
  //  [GET /v1/test_helpers/test_clocks (400)] {request-id=req_OYx1Lh47ntlkvq}"
  'This endpoint is only available in testmode',

  // treasury_financial_accounts
  // "Unrecognized request URL (GET: /v1/treasury/financial_accounts). Please see
  //  https://stripe.com/docs or we can help at https://support.stripe.com/.
  //  (Hint: Have you onboarded to Treasury? You can learn more about the steps needed at
  //  https://stripe.com/docs/treasury/access) [GET /v1/treasury/financial_accounts (400)]
  //  {request-id=req_IUY53toFOUrzG6}"
  'Have you onboarded to Treasury',

  // v2_core_accounts
  // "Accounts v2 is not enabled for your platform. If you're interested in using this API with
  //  your integration, please visit
  //  https://dashboard.stripe.com/acct_1DfwS2ClCIKljWvs/settings/connect/platform-setup.
  //  [GET /v2/core/accounts (400)] {request-id=req_v2HaQWYCiDgV6xQZ7, stripe-should-retry=false}"
  'Accounts v2 is not enabled for your platform',

]

function isSkippableError(err: unknown): boolean {
  if (!(err instanceof StripeApiRequestError)) return false
  const body = err.body as { error?: { message?: string } } | undefined
  const message = (body?.error?.message ?? '').toLowerCase()
  return SKIPPABLE_ERROR_MESSAGES.some((p) => message.includes(p.toLowerCase()))
}

// MARK: - Log message helpers (use msg.log directly where possible)

// N-ary search functions and time helpers are imported from @stripe/sync-protocol.

// MARK: - Time range reconciliation

/**
 * Reconcile `remaining` ranges when the incoming `time_range` differs from
 * the previously `accounted_range`. Rules:
 *   1. Drop ranges fully outside the new time_range
 *   2. Trim ranges that partially overlap the new boundaries
 *   3. Add new ranges for uncovered territory
 *   4. Return the new accounted_range (= time_range)
 */
export function reconcileRanges(
  remaining: RemainingRange[],
  accounted: { gte: string; lt: string },
  incoming: { gte: string; lt: string }
): RemainingRange[] {
  const result: RemainingRange[] = []

  for (const range of remaining) {
    const rGte = range.gte
    const rLt = range.lt
    // Drop fully outside
    if (rLt <= incoming.gte || rGte >= incoming.lt) continue
    // Trim to fit
    result.push({
      gte: rGte < incoming.gte ? incoming.gte : rGte,
      lt: rLt > incoming.lt ? incoming.lt : rLt,
      cursor: rGte < incoming.gte ? null : range.cursor, // reset cursor if gte trimmed
    })
  }

  // Add uncovered territory below
  if (incoming.gte < accounted.gte) {
    result.push({ gte: incoming.gte, lt: accounted.gte, cursor: null })
  }
  // Add uncovered territory above
  if (incoming.lt > accounted.lt) {
    result.push({ gte: accounted.lt, lt: incoming.lt, cursor: null })
  }

  return result
}

// MARK: - Account created timestamp

async function getAccountCreatedTimestamp(client: StripeClient): Promise<number> {
  try {
    const account = await client.getAccount()
    return account.created ?? STRIPE_LAUNCH_TIMESTAMP
  } catch {
    return STRIPE_LAUNCH_TIMESTAMP
  }
}

// mergeAsync is imported from @stripe/sync-protocol above

// MARK: - Resource config lookup

function findConfigByTableName(
  registry: Record<string, ResourceConfig>,
  tableName: string
): ResourceConfig | undefined {
  return Object.values(registry).find((cfg) => cfg.tableName === tableName)
}

// MARK: - Detect and discard legacy state

function isLegacyState(data: unknown): boolean {
  if (data == null || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  return 'backfill' in obj || 'segments' in obj || 'status' in obj || 'page_cursor' in obj
}

// MARK: - Single-range pagination

async function* paginateRange(opts: {
  range: RemainingRange
  remaining: RemainingRange[]
  accountedRange: { gte: string; lt: string }
  listFn: ListFn
  streamName: string
  accountId: string
  supportsLimit: boolean
  supportsForwardPagination: boolean
  supportsCreatedFilter: boolean
  backfillLimit?: number
  totalEmitted: { count: number }
  lastSeenCreated: Map<RemainingRange, number>
  /** When true, fetch only one page then return (allows outer loop to subdivide). */
  singlePage?: boolean
}): AsyncGenerator<Message> {
  const {
    range,
    remaining,
    accountedRange,
    listFn,
    streamName,
    accountId,
    supportsLimit,
    supportsForwardPagination,
    supportsCreatedFilter,
    backfillLimit,
    totalEmitted,
    lastSeenCreated,
    singlePage,
  } = opts

  let cursor = range.cursor
  let hasMore = true

  while (hasMore) {
    const params: Record<string, unknown> = {}
    if (supportsCreatedFilter) {
      params.created = { gte: toUnixSeconds(range.gte), lt: toUnixSeconds(range.lt) }
    }
    if (supportsForwardPagination && supportsLimit) {
      params.limit = 100
    }
    if (supportsForwardPagination && cursor) {
      params.starting_after = cursor
    }

    const response = await listFn(params as Parameters<typeof listFn>[0])

    for (const item of response.data) {
      const record = item as Record<string, unknown>
      if (typeof record.created === 'number') {
        lastSeenCreated.set(range, record.created)
      }
      yield msg.record({
        stream: streamName,
        data: { ...record, _account_id: accountId },
        emitted_at: new Date().toISOString(),
      })
      totalEmitted.count++
    }

    hasMore = supportsForwardPagination && response.has_more
    if (response.pageCursor) {
      cursor = response.pageCursor
    } else if (response.data.length > 0) {
      cursor = (response.data[response.data.length - 1] as { id: string }).id
    }

    if (backfillLimit && totalEmitted.count >= backfillLimit) {
      hasMore = false
    }

    // Update range cursor in-place for state checkpoint
    range.cursor = hasMore ? cursor : null

    yield msg.source_state({
      state_type: 'stream',
      stream: streamName,
      data: {
        accounted_range: accountedRange,
        remaining: remaining.filter((r) => r.cursor !== null || hasMore || r !== range),
      },
    })

    // In singlePage mode, return after one page so the outer loop can subdivide
    if (singlePage && hasMore) return
  }

  // Range exhausted — remove from remaining and emit range_complete
  const idx = remaining.indexOf(range)
  if (idx !== -1) remaining.splice(idx, 1)

  yield msg.stream_status({
    stream: streamName,
    status: 'range_complete',
    range_complete: { gte: range.gte, lt: range.lt },
  })

  yield msg.source_state({
    state_type: 'stream',
    stream: streamName,
    data: {
      accounted_range: accountedRange,
      remaining: [...remaining],
    },
  })
}

// MARK: - Single-stream backfill

async function* iterateStream(opts: {
  streamName: string
  timeRange: { gte: string; lt: string }
  streamState: StreamState | undefined
  resourceConfig: ResourceConfig & { listFn: ListFn }
  accountId: string
  rateLimiter: RateLimiter
  backfillLimit?: number
  getMaxSegments: () => number
  signal?: AbortSignal
  drainQueue?: () => AsyncGenerator<Message>
}): AsyncGenerator<Message> {
  const {
    streamName,
    timeRange,
    resourceConfig,
    accountId,
    rateLimiter,
    backfillLimit,
    getMaxSegments,
    drainQueue,
  } = opts

  let remaining: RemainingRange[]
  const accountedRange = { gte: timeRange.gte, lt: timeRange.lt }

  if (opts.streamState && !isLegacyState(opts.streamState)) {
    const existingAccounted = opts.streamState.accounted_range
    if (
      existingAccounted &&
      (existingAccounted.gte !== timeRange.gte || existingAccounted.lt !== timeRange.lt)
    ) {
      // time_range changed — reconcile remaining against new range
      remaining = reconcileRanges(
        opts.streamState.remaining.map((r) => ({ ...r })),
        existingAccounted,
        timeRange
      )
    } else {
      remaining = opts.streamState.remaining.map((r) => ({ ...r }))
    }
    if (remaining.length === 0) return
  } else {
    if (opts.streamState && isLegacyState(opts.streamState)) {
      yield msg.log({
        level: 'warn',
        message: `${streamName}: discarding legacy state, starting fresh`,
      })
    }
    remaining = [{ gte: timeRange.gte, lt: timeRange.lt, cursor: null }]
  }

  yield msg.stream_status({ stream: streamName, status: 'start', time_range: timeRange })

  const rateLimitedListFn = withRateLimit(resourceConfig.listFn!, rateLimiter, opts.signal)
  const supportsCreatedFilter = resourceConfig.supportsCreatedFilter
  const supportsLimit = resourceConfig.supportsLimit !== false
  const supportsForwardPagination = resourceConfig.supportsForwardPagination !== false
  const totalEmitted = { count: 0 }
  const lastSeenCreated = new Map<RemainingRange, number>()


  // Paginate ranges — subdivide after every page to maximize parallelism.
  // Subdivision only helps when the API supports created-time filtering;
  // without it every range produces the same request, so paginate sequentially.
  while (remaining.length > 0) {
    if (drainQueue) yield* drainQueue()

    if (backfillLimit && totalEmitted.count >= backfillLimit) break

    const maxSegments = supportsCreatedFilter ? getMaxSegments() : 1

    // Pick batch from current remaining (up to maxSegments)
    const batch = remaining.slice(0, maxSegments)

    // Fetch one page from each range in the batch (in parallel)
    const generators = batch.map((range) =>
      paginateRange({
        range,
        remaining,
        accountedRange,
        listFn: rateLimitedListFn,
        streamName,
        accountId,
        supportsLimit,
        supportsForwardPagination,
        supportsCreatedFilter,
        backfillLimit,
        totalEmitted,
        lastSeenCreated,
        singlePage: supportsCreatedFilter,
      })
    )

    if (generators.length === 1) {
      yield* generators[0]
    } else {
      yield* mergeAsync(generators, maxSegments)
    }

    // After pages complete, subdivide based on what we learned
    if (supportsCreatedFilter && remaining.length > 0) {
      const subdivided = nextStep({ remaining, lastObserved: lastSeenCreated }, maxSegments)
      remaining.length = 0
      remaining.push(...subdivided)
      lastSeenCreated.clear()
    }
  }

  yield msg.stream_status({ stream: streamName, status: 'complete' })
}

// MARK: - Main entry point

export async function* listApiBackfill(opts: {
  catalog: {
    streams: Array<{
      stream: { name: string }
      backfill_limit?: number | undefined
      time_range?: { gte: string; lt: string } | undefined
    }>
  }
  state: Record<string, unknown> | undefined
  registry: Record<string, ResourceConfig>
  client: StripeClient
  accountCreated?: number
  accountId: string
  rateLimiter: RateLimiter
  backfillLimit?: number
  maxConcurrentStreams: number
  maxRequestsPerSecond: number
  drainQueue?: () => AsyncGenerator<Message>
  signal?: AbortSignal
}): AsyncGenerator<Message> {
  const {
    catalog,
    state,
    registry,
    client,
    accountCreated: initialAccountCreated,
    accountId,
    rateLimiter,
    backfillLimit,
    maxConcurrentStreams,
    maxRequestsPerSecond,
    drainQueue,
  } = opts

  // Track active streams so we can dynamically allocate segments per stream.
  // All streams run concurrently (breadth-first) — small streams complete in 1-2
  // pages, freeing the rate budget for the remaining big streams.
  let activeStreams = catalog.streams.length
  // Minimum 2: the n-ary search needs at least head + 1 tail segment to subdivide.
  const getMaxSegments = () => Math.max(2, Math.floor(maxRequestsPerSecond / activeStreams))

  let accountCreated: number | null = initialAccountCreated ?? null

  const streamGenerators: AsyncGenerator<Message>[] = []

  for (const configuredStream of catalog.streams) {
    const stream = configuredStream.stream
    const streamBackfillLimit = configuredStream.backfill_limit ?? backfillLimit
    const resourceConfig = findConfigByTableName(registry, stream.name)
    if (!resourceConfig) {
      streamGenerators.push(
        (async function* () {
          yield msg.stream_status({
            stream: stream.name,
            status: 'error',
            error: `Unknown stream: ${stream.name}`,
          })
        })()
      )
      continue
    }

    if (!resourceConfig.listFn) continue

    // Compute time_range: prefer catalog, fall back to account created -> now
    let timeRange = configuredStream.time_range
    if (!timeRange) {
      if (accountCreated === null) {
        accountCreated = await getAccountCreatedTimestamp(client)
      }
      const now = Math.floor(Date.now() / 1000) + 1
      timeRange = { gte: toIso(accountCreated), lt: toIso(now) }
    }

    const streamState = state?.[stream.name] as StreamState | undefined

    streamGenerators.push(
      (async function* () {
        try {
          yield* iterateStream({
            streamName: stream.name,
            timeRange,
            streamState,
            resourceConfig: { ...resourceConfig, listFn: resourceConfig.listFn! },
            accountId,
            rateLimiter,
            backfillLimit: streamBackfillLimit,
            getMaxSegments,
            signal: opts.signal,
            drainQueue,
          })
        } catch (err) {
          if (isSkippableError(err)) {
            yield msg.stream_status({
              stream: stream.name,
              status: 'skip',
              reason: err instanceof Error ? err.message : String(err),
            })
            return
          }
          console.error({
            msg: 'Stripe list page failed',
            stream: stream.name,
            error: err instanceof Error ? err.message : String(err),
          })

          yield msg.stream_status({
            stream: stream.name,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          })
        } finally {
          activeStreams = Math.max(1, activeStreams - 1)
        }
      })()
    )
  }

  // Run all streams concurrently — rate limiter controls actual request throughput
  yield* mergeAsync(streamGenerators, streamGenerators.length)
}
