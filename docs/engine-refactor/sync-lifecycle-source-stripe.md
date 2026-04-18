# Sync Lifecycle — Stripe Source

How the Stripe source manages pagination within a `time_range` assigned by the
engine. For the overall sync lifecycle and protocol, see
[sync-lifecycle.md](./sync-lifecycle.md).

## Overview

The engine assigns a `time_range` per stream via the configured catalog. The
Stripe source paginates all records within that range using an n-ary search
algorithm: start with the full range, paginate, and subdivide if the range
takes more than one request to complete. No upfront density probing — the source discovers
the right granularity by doing the work.

## Source State

```ts
type StripeStreamState = {
  accounted_range: {
    gte: string // ISO 8601 — inclusive lower bound
    lt: string // ISO 8601 — exclusive upper bound
  }
  remaining: Array<{
    gte: string // ISO 8601 — inclusive lower bound
    lt: string // ISO 8601 — exclusive upper bound
    cursor: string | null // Stripe pagination cursor; null = not yet started
  }>
}
```

- `accounted_range` → the `time_range` that `remaining` was computed against.
- `cursor: null` → range planned but first page not yet fetched.
- `cursor: "cus_abc"` → resume pagination after this object.
- Range removed from list → complete.
- `remaining: []` → source is done with the `accounted_range`.

### Constraints

- Only resources with `created[gte]`/`created[lt]` filter support are
  supported. Resources without created filter are out of scope.
- Because `time_range.lt` is always in the past (frozen `time_ceiling`), no
  new objects can appear within a completed range. This makes the n-ary
  subdivision safe without needing a global `starting_after` safety cursor.

## Algorithm

### 1. Initialization (no existing state)

The source receives `time_range` from the catalog and has no state. It starts
with the full range as a single entry:

```
Engine assigns: time_range { gte: "2018-01-01", lt: "2024-04-17" }

state: {
  remaining: [
    { gte: "2018-01-01", lt: "2024-04-17", cursor: null }
  ]
}
```

### 2. Pagination

The source picks a range from `remaining` and paginates it:

1. Call the Stripe list API with `created[gte]` and `created[lt]` filters,
   plus `starting_after` if cursor is set.
2. Emit records.
3. Update cursor in state, emit `source_state`.
4. When a range is exhausted (`has_more: false`), remove it from `remaining`.

```
First page fetched, got cursor:

state: {
  remaining: [
    { gte: "2018-01-01", lt: "2024-04-17", cursor: "cus_abc" }
  ]
}
→ emit source_state

Pagination exhausted, range complete:

state: {
  remaining: []
}
→ emit source_state (done)
```

### 3. Subdivision (n-ary search)

If a range didn't complete in the previous request, the source subdivides it
at the start of the next request. The source knows the `created` timestamp of
the last record it paginated (from the cursor). It splits the unpaginated
portion into N parts (where N = `max_segments_per_stream`):

```
Previous request ended with:
  remaining: [{ gte: "2018-01-01", lt: "2024-04-17", cursor: "cus_xyz" }]

Last record seen had created=2020-06-15. Range didn't complete → subdivide.
The paginated portion [2018, 2020-06-15) keeps its cursor.
The unpaginated portion [2020-06-15, 2024-04-17) splits into N=2:

  remaining: [
    { gte: "2018-01-01", lt: "2020-06-15", cursor: "cus_xyz" },
    { gte: "2020-06-15", lt: "2022-05-16", cursor: null },
    { gte: "2022-05-16", lt: "2024-04-17", cursor: null }
  ]
```

**When to subdivide:** At the start of a request, if any range in `remaining`
has a cursor (meaning it was in progress last request but didn't complete).
Subdivision happens between requests, not mid-request.

**Recursive:** If a subdivided range still doesn't complete in one request,
it gets split again next time. Each pass narrows the ranges until they're
small enough to complete in a single request.

### 4. Resumption (existing state, same time_range)

If the source has existing state and the incoming `time_range` matches
`accounted_range`, it resumes directly from `remaining`:

```
Source receives time_range { gte: "2018-01-01", lt: "2024-04-17" }
Existing state: {
  accounted_range: { gte: "2018-01-01", lt: "2024-04-17" },
  remaining: [
    { gte: "2022-05-16", lt: "2024-04-17", cursor: "cus_xyz" }
  ]
}

→ accounted_range matches time_range — no reconciliation needed
→ Resume paginating from cus_xyz in [2022-05-16, 2024-04-17)
```

### 4b. Reconciliation (time_range changed)

If the incoming `time_range` differs from `accounted_range`, the source
reconciles `remaining` before resuming. This happens across sync runs (new
`time_ceiling`) or when the client changes the catalog.

**Rules:**

1. Drop ranges fully outside the new `time_range`
2. Trim ranges that partially overlap the new boundaries
3. Add new ranges for uncovered territory:
   - If `time_range.gte < accounted_range.gte`: add `[time_range.gte, accounted_range.gte)`
   - If `time_range.lt > accounted_range.lt`: add `[accounted_range.lt, time_range.lt)`
4. Set `accounted_range = time_range`

**Example — lt extended (new run, new time_ceiling):**

```
accounted_range: { gte: "2018", lt: "2024" }
remaining: []  (previous run completed)

Incoming time_range: { gte: "2018", lt: "2026" }

→ Gap: [2024, 2026) not covered
→ Add { gte: "2024", lt: "2026", cursor: null }
→ accounted_range = { gte: "2018", lt: "2026" }
```

**Example — gte advanced (engine advanced based on completed_ranges):**

```
accounted_range: { gte: "2018", lt: "2026" }
remaining: [
  { gte: "2018", lt: "2020", cursor: "cus_abc" },
  { gte: "2022", lt: "2026", cursor: null }
]

Incoming time_range: { gte: "2020", lt: "2026" }

→ Drop { gte: "2018", lt: "2020", cursor: "cus_abc" } (fully below new gte)
→ remaining: [{ gte: "2022", lt: "2026", cursor: null }]
→ accounted_range = { gte: "2020", lt: "2026" }
```

**Example — gte decreased (user widened backwards):**

```
accounted_range: { gte: "2018", lt: "2024" }
remaining: [{ gte: "2022", lt: "2024", cursor: "cus_xyz" }]

Incoming time_range: { gte: "2016", lt: "2024" }

→ Gap: [2016, 2018) not covered
→ Add { gte: "2016", lt: "2018", cursor: null }
→ remaining: [
    { gte: "2016", lt: "2018", cursor: null },
    { gte: "2022", lt: "2024", cursor: "cus_xyz" }
  ]
→ accounted_range = { gte: "2016", lt: "2024" }
```

### 5. Completion

When a sub-range is exhausted, the source removes it from `remaining` and
emits a `stream_status: range_complete`:

```
→ emit stream_status: { stream: 'customers', status: 'range_complete',
    range_complete: { gte: '2018-01-01', lt: '2019-06-01' } } }
```

The engine merges this into `completed_ranges`.

When all sub-ranges are done (`remaining: []`), the source emits
`stream_status: complete` for the stream.

## Full Example

Shows the messages emitted by the source during a two-request backfill of
`customers` with `time_range: [2018, 2024)`.

### Request 1 — full range, doesn't complete

Stripe returns max 100 records per page. Each page = 1 API request = 1 state
checkpoint.

```
Source initializes: remaining: [{ gte: "2018", lt: "2024", cursor: null }]

← stream_status: { stream: "customers", status: "start" } }
← record  { stream: "customers", data: { id: "cus_001", ... } }
  ... 100 records (page 1) ...
← state   { stream: "customers", data: { remaining: [{ gte: "2018", lt: "2024", cursor: "cus_100" }] } }
← record  { stream: "customers", data: { ... } }
  ... 100 records (page 2) ...
← state   { stream: "customers", data: { remaining: [{ gte: "2018", lt: "2024", cursor: "cus_200" }] } }
  ... pages 3-50 (5000 records total) ...
← state   { stream: "customers", data: { remaining: [{ gte: "2018", lt: "2024", cursor: "cus_5000" }] } }
  ... source cut off (time limit / state limit) ...

← end     { has_more: true }
```

Range didn't complete in one request → source will subdivide on next request.

### Request 2 — source subdivides, finishes first sub-range

```
Source resumes, sees remaining: [{ gte: "2018", lt: "2024", cursor: "cus_5000" }]
Last record had created=2019-03. Range didn't complete → subdivide:
  remaining: [
    { gte: "2018", lt: "2019-03", cursor: "cus_5000" },   // current (has cursor)
    { gte: "2019-03", lt: "2021-09", cursor: null },        // new
    { gte: "2021-09", lt: "2024", cursor: null }             // new
  ]

← record  { stream: "customers", data: { ... } }
  ... 100 records (page) ...
← state   { ... }
  ... finishes [2018, 2019-03) after a few more pages ...
← stream_status: { stream: "customers", status: "range_complete",
              range_complete: { gte: "2018", lt: "2019-03" } } }
← state   { stream: "customers", data: { remaining: [
              { gte: "2019-03", lt: "2021-09", cursor: null },
              { gte: "2021-09", lt: "2024", cursor: null }
           ] } }
  ... starts [2019-03, 2021-09), paginates several pages ...
← state   { stream: "customers", data: { remaining: [
              { gte: "2019-03", lt: "2021-09", cursor: "cus_8000" },
              { gte: "2021-09", lt: "2024", cursor: null }
           ] } }
  ... cut off ...

← end     { has_more: true }
```

### Request 3 — finishes remaining ranges

```
Source resumes: remaining: [
  { gte: "2019-03", lt: "2021-09", cursor: "cus_8000" },
  { gte: "2021-09", lt: "2024", cursor: null }
]
These ranges made progress last request — no further subdivision, resume.

  ... paginates [2019-03, 2021-09) page by page ...
← stream_status: { stream: "customers", status: "range_complete",
              range_complete: { gte: "2019-03", lt: "2021-09" } } }
  ... paginates [2021-09, 2024) page by page ...
← stream_status: { stream: "customers", status: "range_complete",
              range_complete: { gte: "2021-09", lt: "2024" } } }
← state   { stream: "customers", data: { remaining: [] } }
← stream_status: { stream: "customers", status: "complete" } }

← end     { has_more: false }
```

Engine's `completed_ranges` for customers after merging all `range_complete` messages:
`[{ gte: "2018", lt: "2024" }]`

## State on the Wire

Source state is opaque to the engine. The engine learns about range completion
via `stream_status: range_complete` messages, not by inspecting source state:

```ts
{
  type: 'source_state',
  source_state: {
    state_type: 'stream',
    stream: 'customers',
    time_range: { gte: '2018-01-01T00:00:00Z', lt: '2024-04-17T00:00:00Z' },
    data: {
      remaining: [
        { gte: '2022-05-16T00:00:00Z', lt: '2024-04-17T00:00:00Z', cursor: 'cus_xyz' }
      ]
    }
  }
}
```

## Concurrency

Three controls govern how the source uses the Stripe API:

```ts
// Source config — only max_concurrent_streams is user-configurable
type StripeSourceConfig = {
  api_key: string
  account_id?: string
  max_concurrent_streams?: number // default 5
}

// Derived internally by the source:
// live_mode              = inferred from api_key prefix (sk_live_ vs sk_test_)
// max_requests_per_second = live_mode ? 20 : 10
// effective_streams       = min(max_concurrent_streams, configured_stream_count)
// max_segments_per_stream = floor(max_requests_per_second / effective_streams)
```

| Control                   | What it controls                             | How it's set                               |
| ------------------------- | -------------------------------------------- | ------------------------------------------ |
| `max_concurrent_streams`  | Streams paginating in parallel               | Config (default 5), capped at catalog size |
| `max_requests_per_second` | Global rate limit across all activity        | Inferred from API key mode                 |
| `max_segments_per_stream` | Sub-ranges per stream (n-ary search fan-out) | Derived: rps / concurrent streams          |

### Examples

| Scenario         | Mode | Streams | `effective_streams` | `rps` | `max_segments_per_stream` | Max concurrent requests |
| ---------------- | ---- | ------- | ------------------- | ----- | ------------------------- | ----------------------- |
| 20 streams, live | live | 20      | 5                   | 20    | 4                         | 20                      |
| 20 streams, test | test | 20      | 5                   | 10    | 2                         | 10                      |
| 3 streams, live  | live | 3       | 3                   | 20    | 6                         | 18                      |
| 1 stream, live   | live | 1       | 1                   | 20    | 20                        | 20                      |
| 1 stream, test   | test | 1       | 1                   | 10    | 10                        | 10                      |

When fewer streams are configured, each stream gets more segments — the full
rate limit budget is distributed across whatever streams exist. A single-stream
sync gets the entire budget.

## Parallel Pagination

The source paginates up to `max_segments_per_stream` ranges from `remaining`
concurrently per stream, and up to `effective_streams` streams in parallel.
Records from different ranges/streams are interleaved on the output stream.
State checkpoints are emitted after each page, reflecting the current state
of all ranges. This ensures resumability if the source is cut off mid-run.

The global rate limiter (`max_requests_per_second`) governs all API calls
regardless of which stream or segment they belong to.

## Source Logs

The Stripe source emits `log` messages for real-time operational visibility.
These are passed through by the engine.

| Level | Message                               | When                           |
| ----- | ------------------------------------- | ------------------------------ |
| info  | `{stream}: {rps} requests/sec`        | Periodically during pagination |
| warn  | `rate limited: retrying in {n}s`      | Stripe returned 429            |
| warn  | `retry {n}/{max}: {status} {message}` | Request failed, retrying       |

## Error Handling

- **Transient errors** (rate limits, 5xx, timeouts): Retried at the HTTP
  layer with exponential backoff. Log a warning for observability.
- **Stream errors** (resource not available, permission denied): Log the
  error, emit `stream_status: error`, move to the next stream.
- **Global errors** (invalid API key): Emit `connection_status: failed`
  with reason, then exhaust.

The source does not store error state. If a range fails after all retries,
the range stays in `remaining` with its cursor for the next attempt.

## Events

The `/events` endpoint is treated as just another stream in the catalog —
same `time_range` model, same `remaining`-based pagination. No special
incremental mode or live polling by default.

For experimental live event polling (using events as a webhook replacement),
an opt-in flag stores cursor state in `source.global`, which is completely
separate from the per-stream backfill cursor logic. This is not enabled by
default.
