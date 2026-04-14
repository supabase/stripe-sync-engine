# Adaptive Backfill: Rate-Limited ListFn + Smooth Segmentation + Continuous Probing

**Status**: Plan (not yet implemented)
**PR context**: [#281](https://github.com/stripe/sync-engine-fork/pull/281) removes `backfill_concurrency` and adds a one-shot probe

## Problem

PR #281 replaces the user-facing `backfill_concurrency` knob with a one-shot probe that picks from three discrete tiers (1, 10, 50). This is better than making users guess, but has several weaknesses:

1. **Wasted API call** — the probe fetches 100 items then discards them
2. **Discrete tiers** — cliff edges at the thresholds (9.9% → 50 segments, 10.1% → 10)
3. **Uniform assumption** — one measurement for the whole time range, but density varies (sparse 2012 history, dense 2025 activity)
4. **Rate limiter threading** — `rateLimiter` is passed separately everywhere and callers must remember to call it

## Design

Three changes, each independently valuable, buildable in sequence:

### Change 1: Rate-limited ListFn wrapper

Bake rate limiting into the list function so it's impossible to forget.

**Current** — every call site does this:

```ts
const wait = await rateLimiter()
if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000))
const response = await listFn(params)
```

This pattern appears in `paginateSegment`, `sequentialBackfillStream`, and now `probeSegmentCount` — three places with identical boilerplate.

**Proposed** — wrap once at construction:

```ts
function withRateLimit(listFn: ListFn, rateLimiter: RateLimiter): ListFn {
  return async (params) => {
    const wait = await rateLimiter()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait * 1000))
    return listFn(params)
  }
}
```

Apply in `listApiBackfill` at the top of the stream loop, before passing `listFn` into anything:

```ts
const rateLimitedListFn = withRateLimit(resourceConfig.listFn!, rateLimiter)
```

Then `paginateSegment`, `sequentialBackfillStream`, and probe functions all receive a plain `ListFn` and just call it. `rateLimiter` disappears from their signatures.

**Impact**: Pure refactor, no behavior change. Removes ~6 lines of duplicated rate-limit boilerplate. Makes it structurally impossible to forget rate limiting on a new call site.

### Change 2: Smooth segment count function

Replace discrete tiers with a continuous function. Decouple segment count from concurrency.

**Current** (PR #281):

```
timeProgress >= 0.2  → 1 segment
timeProgress >= 0.1  → 10 segments
timeProgress < 0.1   → 50 segments
```

**Proposed** — continuous mapping:

```ts
const MAX_SEGMENTS = 50
const MAX_CONCURRENCY = 15

function segmentCountFromDensity(timeProgress: number): number {
  if (timeProgress <= 0) return MAX_SEGMENTS
  // Inverse relationship: denser data → more segments
  // timeProgress=1.0 (100 items cover everything) → 1
  // timeProgress=0.5 → 2
  // timeProgress=0.1 → 10
  // timeProgress=0.02 → 50 (capped)
  return Math.max(1, Math.min(MAX_SEGMENTS, Math.ceil(1 / timeProgress)))
}
```

This gives a smooth curve: `ceil(1 / timeProgress)` naturally maps density to segment count. Very sparse (timeProgress=0.8) → 2 segments. Medium (0.1) → 10. Dense (0.02) → 50. No cliff edges.

**Concurrency is separate from segmentation.** The number of time-range segments determines granularity of the work. The concurrency limit determines how many are in-flight simultaneously:

```ts
const numSegments = segmentCountFromDensity(timeProgress)
const segments = buildSegments(accountCreated, now, numSegments)
yield* mergeAsync(generators, MAX_CONCURRENCY) // always capped
```

This means a dense stream gets 50 fine-grained segments but only 15 execute at a time, avoiding the "50 concurrent promises" problem.

**State impact**: `BackfillState.num_segments` stays the same — it records whatever was chosen. Resumption works identically.

### Change 3: Adaptive probing (probe-as-you-go)

Replace the one-shot probe with a scheme where the initial probe feeds into the first segment, and segments can subdivide themselves when they discover dense data.

#### 3a: Use probe results as first page

The simplest improvement: make the probe the first page of the first (most recent) segment, so no data is wasted.

```ts
async function probeAndBuildSegments(opts: {
  listFn: ListFn  // already rate-limited from Change 1
  range: { gte: number; lt: number }
}): Promise<{ segments: SegmentState[]; firstPage: ListResult }> {
  const { listFn, range } = opts

  // Probe: fetch most recent 100 items within the backfill range
  const firstPage = await listFn({ limit: 100, created: { gte: range.gte, lt: range.lt } })

  if (!firstPage.has_more) {
    // Everything fits in one page — single segment, already fetched
    return {
      segments: [{ index: 0, gte: range.gte, lt: range.lt, page_cursor: null, status: 'pending' }],
      firstPage,
    }
  }

  const lastItem = firstPage.data[firstPage.data.length - 1] as { created?: number }
  const totalSpan = range.lt - range.gte
  if (totalSpan <= 0) {
    return {
      segments: [{ index: 0, gte: range.gte, lt: range.lt, page_cursor: null, status: 'pending' }],
      firstPage,
    }
  }

  const timeProgress = (range.lt - (lastItem?.created ?? range.gte)) / totalSpan
  const numSegments = segmentCountFromDensity(timeProgress)
  const segments = buildSegments(range.gte, range.lt - 1, numSegments)

  return { segments, firstPage }
}
```

The caller then feeds `firstPage` into the segment whose time range contains those items (the most recent segment), avoiding the re-fetch. Concretely, when iterating the first (newest) segment, we yield the probe results as records before starting pagination from the probe's last cursor.

**How the first page feeds into the segment:**

```ts
// After probeAndBuildSegments returns, find the segment covering the newest data
const newestSegment = segments[segments.length - 1]

// Yield records from the probe's first page
for (const item of firstPage.data) {
  yield toRecordMessage(streamName, { ...item, _account_id: accountId })
  totalEmitted.count++
}

// Set the segment's cursor so pagination continues from where the probe left off
if (firstPage.has_more && firstPage.data.length > 0) {
  const lastId = (firstPage.data[firstPage.data.length - 1] as { id: string }).id
  newestSegment.page_cursor = lastId
}
```

Then `paginateSegment` picks up from `newestSegment.page_cursor` and continues normally. Zero wasted data.

#### 3b: Adaptive subdivision (future direction)

The most ambitious option. When a segment discovers it's dense (many pages), it can split itself and spawn new parallel work. This is the "binary sort" / quadtree idea.

**Concept:**

```
Initial: 1 coarse segment [2011 ──────────────────── 2026]
                                                         │
Probe: 100 items in last 2% of range → dense      ┌─────┘
                                                   ▼
Split:  [2011 ────── 2020]  [2020 ── 2023]  [2023 ── 2026]
              sparse              medium          dense
                │                   │               │
            1 segment          5 segments       20 segments
```

Each segment, after its first page, can measure its own density and decide to subdivide:

```ts
async function* adaptivePaginateSegment(opts: {
  listFn: ListFn
  segment: SegmentState
  // ... other opts
  spawnSubSegments: (parent: SegmentState, count: number) => SegmentState[]
}): AsyncGenerator<Message> {
  // First page — also acts as density probe for this segment
  const response = await opts.listFn({
    limit: 100,
    created: { gte: opts.segment.gte, lt: opts.segment.lt },
  })

  // Yield records from this page
  for (const item of response.data) { yield toRecordMessage(...) }

  if (!response.has_more) {
    opts.segment.status = 'complete'
    return
  }

  // Measure segment-local density
  const lastItem = response.data[response.data.length - 1] as { created?: number }
  const segSpan = opts.segment.lt - opts.segment.gte
  const localProgress = lastItem?.created
    ? (opts.segment.lt - lastItem.created) / segSpan
    : 0.5

  if (localProgress < 0.1 && segSpan > MIN_SEGMENT_SPAN) {
    // Dense sub-region — subdivide this segment
    const subSegments = opts.spawnSubSegments(opts.segment, 5)
    // Feed first page's cursor into the newest sub-segment
    // Return sub-segments to the parent mergeAsync for parallel execution
    yield* mergeAsync(
      subSegments.map(sub => adaptivePaginateSegment({ ...opts, segment: sub })),
      MAX_CONCURRENCY
    )
  } else {
    // Continue paginating this segment normally
    // ... standard pagination loop
  }
}
```

**State implications**: Adaptive subdivision changes the segment tree at runtime. The compact state format already handles this — `compactState` stores completed ranges and in-flight cursors regardless of how many segments exist. But `num_segments` becomes a hint rather than a fixed value, and `expandState` needs to handle variable-granularity gaps.

**Recommendation**: This is powerful but complex. Save for v2. The combination of Changes 1+2+3a gives 90% of the benefit:

- No wasted API calls
- Smooth segment count proportional to density
- Concurrency capped independently of segment count
- Rate limiting baked in, impossible to forget

### Implementation order

```
Change 1: withRateLimit wrapper
  ├── Pure refactor, safe to land independently
  ├── Touches: src-list-api.ts (remove rateLimiter from paginateSegment,
  │   sequentialBackfillStream; add wrapper in listApiBackfill)
  └── Test: existing tests pass unchanged (behavior identical)

Change 2: Smooth segment count + decoupled concurrency
  ├── Replace probeSegmentCount tiers with segmentCountFromDensity()
  ├── Add MAX_CONCURRENCY constant, use it in mergeAsync call
  ├── Add division-by-zero guard
  └── Test: update probeSegmentCount tests to expect continuous values

Change 3a: Probe-as-first-page
  ├── Return firstPage from probe, yield its records
  ├── Set cursor on newest segment so pagination resumes
  ├── Pass created filter in probe call
  └── Test: verify probe data appears in output, no duplicate fetch

Change 3b: Adaptive subdivision (future)
  └── Design doc + prototype when 3a proves insufficient
```

### Constants

```ts
const MAX_SEGMENTS = 50       // finest granularity for any stream
const MAX_CONCURRENCY = 15    // max in-flight segment generators
const MIN_SEGMENT_SPAN = 86400 // don't subdivide below 1 day (for 3b)
```

`MAX_CONCURRENCY` at 15 is a balance: enough to saturate the default 25 RPS rate limit (each segment does sequential pagination, so 15 segments with ~2 pages/sec each ≈ 30 RPS before rate limiting kicks in), without creating excessive promise/memory pressure.