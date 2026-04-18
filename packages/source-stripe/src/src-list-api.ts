import type { Message } from '@stripe/sync-protocol'
import { createSourceMessageFactory } from '@stripe/sync-protocol'
import type { ListFn } from '@stripe/sync-openapi'
import type { ResourceConfig } from './types.js'
import type { RemainingRange, StreamState } from './index.js'
import type { RateLimiter } from './rate-limiter.js'
import { StripeApiRequestError } from '@stripe/sync-openapi'
import type { StripeClient } from './client.js'

const msg = createSourceMessageFactory<StreamState>()

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

function isGlobalError(err: unknown): boolean {
  if (err instanceof StripeApiRequestError && (err.status === 401 || err.status === 403)) {
    return true
  }
  return false
}

const SKIPPABLE_ERROR_PATTERNS = [
  'only available in testmode',
  'not in live mode',
  'not enabled for',
  'Must provide customer',
  'Must provide ',
  'not set up to use',
]

function isSkippableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return SKIPPABLE_ERROR_PATTERNS.some((p) => msg.includes(p))
}

// MARK: - Log message helpers (use msg.log directly where possible)

// MARK: - Time helpers

function toUnixSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000)
}

function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

// MARK: - N-ary search: subdivision

/**
 * Subdivide ranges that have a cursor (were in progress but didn't complete).
 * The paginated portion keeps its cursor; the unpaginated tail splits into N parts.
 *
 * `lastSeenCreated` maps range index to the `created` timestamp of the last
 * record seen in that range (used to determine the split point).
 */
export function subdivideRanges(
  remaining: RemainingRange[],
  maxSegments: number,
  lastSeenCreated: Map<number, number>
): RemainingRange[] {
  const result: RemainingRange[] = []

  for (let i = 0; i < remaining.length; i++) {
    const range = remaining[i]
    if (range.cursor === null || !lastSeenCreated.has(i)) {
      result.push(range)
      continue
    }

    const splitPoint = lastSeenCreated.get(i)!
    const splitPointIso = toIso(splitPoint)
    const rangeEndUnix = toUnixSeconds(range.lt)

    if (splitPoint >= rangeEndUnix) {
      result.push(range)
      continue
    }

    // Keep the paginated portion with its cursor
    result.push({ gte: range.gte, lt: splitPointIso, cursor: range.cursor })

    // Split the unpaginated tail into N parts
    const tailSpan = rangeEndUnix - splitPoint
    const n = Math.max(1, Math.min(maxSegments, Math.ceil(tailSpan / 1)))
    const segmentSize = Math.max(1, Math.ceil(tailSpan / n))

    for (let j = 0; j < n; j++) {
      const segGte = splitPoint + j * segmentSize
      const segLt = j === n - 1 ? rangeEndUnix : splitPoint + (j + 1) * segmentSize
      if (segGte >= rangeEndUnix) break
      result.push({ gte: toIso(segGte), lt: toIso(segLt), cursor: null })
    }
  }

  return result
}

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

const STRIPE_LAUNCH_TIMESTAMP = Math.floor(new Date('2011-01-01T00:00:00Z').getTime() / 1000)

async function getAccountCreatedTimestamp(client: StripeClient): Promise<number> {
  try {
    const account = await client.getAccount()
    return account.created ?? STRIPE_LAUNCH_TIMESTAMP
  } catch {
    return STRIPE_LAUNCH_TIMESTAMP
  }
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
  lastSeenCreated: Map<number, number>
  rangeIndex: number
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
    rangeIndex,
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
        lastSeenCreated.set(rangeIndex, record.created)
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

async function* backfillStream(opts: {
  streamName: string
  timeRange: { gte: string; lt: string }
  streamState: StreamState | undefined
  resourceConfig: ResourceConfig & { listFn: ListFn }
  accountId: string
  rateLimiter: RateLimiter
  backfillLimit?: number
  maxSegmentsPerStream: number
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
    maxSegmentsPerStream,
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

  yield msg.stream_status({ stream: streamName, status: 'start' })

  const rateLimitedListFn = withRateLimit(resourceConfig.listFn!, rateLimiter, opts.signal)
  const supportsCreatedFilter = resourceConfig.supportsCreatedFilter
  const supportsLimit = resourceConfig.supportsLimit !== false
  const supportsForwardPagination = resourceConfig.supportsForwardPagination !== false
  const totalEmitted = { count: 0 }
  const lastSeenCreated = new Map<number, number>()

  // Subdivide any ranges that were in-progress from a previous request
  const hasInProgress = remaining.some((r) => r.cursor !== null)
  if (hasInProgress) {
    remaining = subdivideRanges(remaining, maxSegmentsPerStream, lastSeenCreated)
  }

  // Paginate ranges — up to maxSegmentsPerStream concurrently
  while (remaining.length > 0) {
    if (drainQueue) yield* drainQueue()

    if (backfillLimit && totalEmitted.count >= backfillLimit) break

    // Build generators for up to maxSegmentsPerStream ranges
    const batch = remaining.slice(0, maxSegmentsPerStream)
    const generators = batch.map((range, i) =>
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
        rangeIndex: i,
      })
    )

    if (generators.length === 1) {
      yield* generators[0]
    } else {
      yield* mergeAsync(generators, maxSegmentsPerStream)
    }

    // After this batch, subdivide any ranges that were in-progress but didn't complete
    if (remaining.length > 0) {
      const stillInProgress = remaining.some((r) => r.cursor !== null)
      if (stillInProgress) {
        const subdivided = subdivideRanges(remaining, maxSegmentsPerStream, lastSeenCreated)
        remaining.length = 0
        remaining.push(...subdivided)
        lastSeenCreated.clear()
      }
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
  accountId: string
  rateLimiter: RateLimiter
  backfillLimit?: number
  maxConcurrentStreams: number
  maxSegmentsPerStream: number
  drainQueue?: () => AsyncGenerator<Message>
  signal?: AbortSignal
}): AsyncGenerator<Message> {
  const {
    catalog,
    state,
    registry,
    client,
    accountId,
    rateLimiter,
    backfillLimit,
    maxConcurrentStreams,
    maxSegmentsPerStream,
    drainQueue,
  } = opts

  let accountCreated: number | null = null

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
          yield* backfillStream({
            streamName: stream.name,
            timeRange,
            streamState,
            resourceConfig: { ...resourceConfig, listFn: resourceConfig.listFn! },
            accountId,
            rateLimiter,
            backfillLimit: streamBackfillLimit,
            maxSegmentsPerStream,
            signal: opts.signal,
            drainQueue,
          })
        } catch (err) {
          if (isSkippableError(err)) {
            yield msg.stream_status({
              stream: stream.name,
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            })
            return
          }
          console.error({
            msg: 'Stripe list page failed',
            stream: stream.name,
            error: err instanceof Error ? err.message : String(err),
          })

          if (isGlobalError(err)) {
            yield msg.connection_status({
              status: 'failed',
              message: err instanceof Error ? err.message : String(err),
            })
            return
          }

          yield msg.stream_status({
            stream: stream.name,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()
    )
  }

  // Run streams in parallel, bounded by maxConcurrentStreams
  yield* mergeAsync(streamGenerators, maxConcurrentStreams)
}
