import type { Message } from '@stripe/sync-protocol'
import {
  nextStep,
  DEFAULT_SUBDIVISION_FACTOR,
  toUnixSeconds,
  toIso,
  mergeAsync,
} from '@stripe/sync-protocol'
import pino from 'pino'
import type { ListFn } from '@stripe/sync-openapi'
import type { ResourceConfig } from './types.js'
import type { RemainingRange, StreamState } from './index.js'
import { msg } from './index.js'
import type { RateLimiter } from './rate-limiter.js'
import { StripeApiRequestError } from '@stripe/sync-openapi'
import type { StripeClient } from './client.js'
import { STRIPE_LAUNCH_TIMESTAMP } from './account-metadata.js'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

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
    if (wait > 0) {
      const wait_ms = Math.round(wait * 1000)
      logger.debug({
        event: 'rate_limit_wait',
        wait_ms,
      })
      await waitForRateLimit(wait_ms, signal)
      logger.debug({
        event: 'rate_limit_resumed',
        waited_ms: wait_ms,
      })
    }
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
  // Variant 1 (with hint):
  // "Unrecognized request URL (GET: /v1/treasury/financial_accounts). Please see
  //  https://stripe.com/docs or we can help at https://support.stripe.com/.
  //  (Hint: Have you onboarded to Treasury? You can learn more about the steps needed at
  //  https://stripe.com/docs/treasury/access) [GET /v1/treasury/financial_accounts (400)]
  //  {request-id=req_IUY53toFOUrzG6}"
  'Have you onboarded to Treasury',
  // Variant 2 (without hint):
  // "Unrecognized request URL (GET: /v1/treasury/financial_accounts). Please see
  //  https://stripe.com/docs or we can help at https://support.stripe.com/.
  //  [GET /v1/treasury/financial_accounts (400)] {request-id=req_...}"
  'Unrecognized request URL (GET: /v1/treasury/financial_accounts)',

  // v2_core_accounts
  // Variant 1:
  // "Accounts v2 is not enabled for your platform. If you're interested in using this API with
  //  your integration, please visit
  //  https://dashboard.stripe.com/acct_1DfwS2ClCIKljWvs/settings/connect/platform-setup.
  //  [GET /v2/core/accounts (400)] {request-id=req_v2HaQWYCiDgV6xQZ7, stripe-should-retry=false}"
  'Accounts v2 is not enabled for your platform',

  // issuing_authorizations, issuing_cardholders, issuing_cards, issuing_disputes, issuing_transactions
  // "Your account is not set up to use Issuing. Please visit
  //  https://dashboard.stripe.com/issuing/overview to get started.
  //  [GET /v1/issuing/authorizations (400)]"
  'Your account is not set up to use Issuing',

  // identity_verification_reports, identity_verification_sessions
  // "Your account is not set up to use Identity. Please have an account admin visit
  //  https://dashboard.stripe.com/identity to get started.
  //  [GET /v1/identity/verification_reports (400)]"
  'Your account is not set up to use Identity',
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
  rangeRecordCounts?: Map<RemainingRange, number>
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
    rangeRecordCounts,
  } = opts

  const hadCursorOnEntry = range.cursor !== null
  let cursor = range.cursor
  let hasMore = true
  let prefetchedResponse: Promise<Awaited<ReturnType<ListFn>>> | null = null

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

    const response = prefetchedResponse
      ? await prefetchedResponse
      : await listFn(params as Parameters<typeof listFn>[0])
    prefetchedResponse = null

    let nextCursor: string | null = null
    const responseHasMore = supportsForwardPagination && response.has_more
    if (response.pageCursor) {
      nextCursor = response.pageCursor
    } else if (response.data.length > 0) {
      nextCursor = (response.data[response.data.length - 1] as { id: string }).id
    }

    // Prefetch the next page to hide latency — but only for sequential ranges
    // (no created filter). Subdivided ranges return after one page, so prefetch
    // would be wasted.
    if (!supportsCreatedFilter && backfillLimit == null && responseHasMore && nextCursor) {
      const nextParams: Record<string, unknown> = {}
      if (supportsCreatedFilter) {
        nextParams.created = { gte: toUnixSeconds(range.gte), lt: toUnixSeconds(range.lt) }
      }
      if (supportsForwardPagination && supportsLimit) {
        nextParams.limit = 100
      }
      if (supportsForwardPagination) {
        nextParams.starting_after = nextCursor
      }
      prefetchedResponse = listFn(nextParams as Parameters<typeof listFn>[0])
    }

    logger.trace({
      event: 'page_fetched',
      stream: streamName,
      range_gte: range.gte,
      range_lt: range.lt,
      range_span_s: toUnixSeconds(range.lt) - toUnixSeconds(range.gte),
      had_cursor: cursor !== null,
      records: response.data.length,
      has_more: responseHasMore,
    })

    if (rangeRecordCounts && response.data.length > 0) {
      rangeRecordCounts.set(range, (rangeRecordCounts.get(range) ?? 0) + response.data.length)
    }

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

    hasMore = responseHasMore
    cursor = nextCursor

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

    // Only subdivide on the FIRST page of a fresh range (entered without a cursor).
    // Ranges that already have a cursor (boundary ranges from prior subdivision)
    // paginate sequentially — subdividing them further creates exponentially many
    // empty probes on sparse data.
    if (supportsCreatedFilter && hasMore && !hadCursorOnEntry) {
      const splitPoint = lastSeenCreated.get(range)
      if (splitPoint != null) {
        const fetchedHeadGteUnix = Math.max(toUnixSeconds(range.gte), splitPoint + 1)
        const fetchedHeadLtUnix = toUnixSeconds(range.lt)
        if (fetchedHeadGteUnix < fetchedHeadLtUnix) {
          yield msg.stream_status({
            stream: streamName,
            status: 'range_complete',
            range_complete: { gte: toIso(fetchedHeadGteUnix), lt: range.lt },
          })
        }
      }
      return
    }
  }

  // Range exhausted — remove from remaining and emit range_complete
  const idx = remaining.indexOf(range)
  if (idx !== -1) remaining.splice(idx, 1)

  yield msg.stream_status({
    stream: streamName,
    status: 'range_complete',
    range_complete: { gte: range.gte, lt: range.lt },
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
  signal?: AbortSignal
  drainQueue?: () => AsyncGenerator<Message>
  subdivisionFactor: number
}): AsyncGenerator<Message> {
  const {
    streamName,
    timeRange,
    resourceConfig,
    accountId,
    rateLimiter,
    backfillLimit,
    drainQueue,
    subdivisionFactor,
  } = opts

  let remaining: RemainingRange[]
  const accountedRange = { gte: timeRange.gte, lt: timeRange.lt }

  logger.debug({
    event: 'stream_state_check',
    stream: streamName,
    has_state: !!opts.streamState,
    is_legacy: opts.streamState ? isLegacyState(opts.streamState) : null,
    state_keys: opts.streamState ? Object.keys(opts.streamState as Record<string, unknown>) : null,
  })

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
      logger.debug({
        event: 'state_reconcile',
        stream: streamName,
        old_gte: existingAccounted.gte,
        old_lt: existingAccounted.lt,
        new_gte: timeRange.gte,
        new_lt: timeRange.lt,
        old_remaining: opts.streamState.remaining.length,
        new_remaining: remaining.length,
        new_ranges: remaining.map((r) => ({ gte: r.gte, lt: r.lt, cursor: !!r.cursor })),
      })
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
  // Track per-range record counts for this round (populated by paginateRange via page_fetched)
  const rangeRecordCounts = new Map<RemainingRange, number>()
  let roundNumber = 0
  let totalApiCalls = 0
  let totalEmptyProbes = 0
  const syncStart = Date.now()

  // Paginate ranges — subdivide after every page to maximize parallelism.
  // Subdivision only helps when the API supports created-time filtering;
  // without it every range produces the same request, so paginate sequentially.
  while (remaining.length > 0) {
    if (drainQueue) yield* drainQueue()

    if (backfillLimit && totalEmitted.count >= backfillLimit) break

    const roundStart = Date.now()
    const rangesThisRound = remaining.length
    const recordsBefore = totalEmitted.count
    // Snapshot ranges before the round (paginateRange mutates remaining)
    const roundRanges = remaining.map((r) => ({
      ref: r,
      gte: r.gte,
      lt: r.lt,
      hadCursor: r.cursor !== null,
    }))
    rangeRecordCounts.clear()

    // Fetch one page from each range in parallel (rate limiter controls concurrency)
    const generators = remaining.map((range) =>
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
        rangeRecordCounts,
      })
    )

    if (generators.length === 1) {
      yield* generators[0]
    } else {
      yield* mergeAsync(generators, generators.length)
    }

    totalApiCalls += rangesThisRound
    const recordsThisRound = totalEmitted.count - recordsBefore

    // After pages complete, subdivide based on what we learned
    if (supportsCreatedFilter && remaining.length > 0) {
      const rangesWithData = lastSeenCreated.size
      // Ranges that completed (removed from remaining) with 0 records
      const rangesExhausted = rangesThisRound - remaining.length
      const emptyExhausted = roundRanges.filter(
        (r) => !remaining.includes(r.ref) && !rangeRecordCounts.has(r.ref)
      ).length
      totalEmptyProbes += emptyExhausted

      // Build per-segment histogram: how many records each segment returned
      const segmentCounts = roundRanges.map((r) => rangeRecordCounts.get(r.ref) ?? 0)
      segmentCounts.sort((a, b) => a - b)

      const subdivided = nextStep({ remaining, lastObserved: lastSeenCreated }, subdivisionFactor)

      logger.debug({
        event: 'subdivision_round',
        stream: streamName,
        subdivision_factor: subdivisionFactor,
        round: roundNumber,
        round_ms: Date.now() - roundStart,
        ranges_fetched: rangesThisRound,
        ranges_with_data: rangesWithData,
        ranges_exhausted: rangesExhausted,
        ranges_empty: emptyExhausted,
        records_this_round: recordsThisRound,
        records_per_segment: {
          min: segmentCounts[0],
          p50: segmentCounts[Math.floor(segmentCounts.length / 2)],
          p90: segmentCounts[Math.floor(segmentCounts.length * 0.9)],
          max: segmentCounts[segmentCounts.length - 1],
          histogram: segmentCounts,
        },
        new_ranges: subdivided.length,
        total_records: totalEmitted.count,
        total_api_calls: totalApiCalls,
        total_empty_probes: totalEmptyProbes,
        elapsed_ms: Date.now() - syncStart,
      })

      remaining.length = 0
      remaining.push(...subdivided)
      lastSeenCreated.clear()
    }

    roundNumber++
  }

  logger.debug({
    event: 'subdivision_complete',
    stream: streamName,
    total_rounds: roundNumber,
    total_api_calls: totalApiCalls,
    total_empty_probes: totalEmptyProbes,
    total_records: totalEmitted.count,
    elapsed_ms: Date.now() - syncStart,
    effective_rps: totalApiCalls / ((Date.now() - syncStart) / 1000),
  })

  // Emit final state with empty remaining so consumers always see the completed state,
  // regardless of what intermediate state messages were emitted during subdivision rounds.
  yield msg.source_state({
    state_type: 'stream',
    stream: streamName,
    data: {
      accounted_range: accountedRange,
      remaining: [],
    },
  })

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
    drainQueue,
  } = opts

  let accountCreated: number | null = initialAccountCreated ?? null

  const streamRuns: Array<{ generator: AsyncGenerator<Message>; primedComplete: boolean }> = []

  for (const configuredStream of catalog.streams) {
    const stream = configuredStream.stream
    const streamBackfillLimit = configuredStream.backfill_limit ?? backfillLimit
    const resourceConfig = findConfigByTableName(registry, stream.name)
    if (!resourceConfig) {
      streamRuns.push({
        primedComplete: false,
        generator: (async function* () {
          yield msg.stream_status({
            stream: stream.name,
            status: 'error',
            error: `Unknown stream: ${stream.name}`,
          })
        })(),
      })
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

    streamRuns.push({
      primedComplete: false,
      generator: (async function* () {
        try {
          yield* iterateStream({
            streamName: stream.name,
            timeRange,
            streamState,
            resourceConfig: { ...resourceConfig, listFn: resourceConfig.listFn! },
            accountId,
            rateLimiter,
            backfillLimit: streamBackfillLimit,
            signal: opts.signal,
            drainQueue,
            subdivisionFactor: Number(process.env.SUBDIVISION_FACTOR) || DEFAULT_SUBDIVISION_FACTOR,
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
        }
      })(),
    })
  }

  // Breadth-first opening pass: prime every stream through its first page/checkpoint.
  // This restores the old "one request to all streams" behavior before we fall back
  // to the bounded scheduler for the remaining work.
  const primingGenerators = streamRuns.map((run) =>
    (async function* () {
      while (true) {
        const { value, done } = await run.generator.next()
        if (done) {
          run.primedComplete = true
          return
        }

        yield value

        if (
          value.type === 'source_state' ||
          (value.type === 'stream_status' &&
            (value.stream_status.status === 'complete' ||
              value.stream_status.status === 'skip' ||
              value.stream_status.status === 'error'))
        ) {
          if (value.type === 'stream_status' && value.stream_status.status !== 'range_complete') {
            run.primedComplete = true
          }
          return
        }
      }
    })()
  )

  yield* mergeAsync(primingGenerators, primingGenerators.length)

  const remainingGenerators = streamRuns
    .filter((run) => !run.primedComplete)
    .map((run) => run.generator)
  yield* mergeAsync(remainingGenerators, Math.min(maxConcurrentStreams, remainingGenerators.length))
}
