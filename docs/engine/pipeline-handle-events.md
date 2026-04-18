# Idea: Separating Event Handling from Sync

One possible direction: extract push-mode event handling out of `/pipeline_sync`
into a dedicated `/pipeline_handle_events` endpoint.

> **Status:** Idea / exploration. May or may not be the right call — captured
> here for discussion.

---

## Current State

Today, `/pipeline_sync` serves two modes via the same endpoint:

1. **Backfill mode** (no request body) — reads from the source connector and
   writes to the destination.
2. **Push mode** (NDJSON request body) — accepts `source_input` messages
   (e.g. webhook event payloads) and pipes them through the source connector
   into the destination instead of reading from the API.

The mode is determined implicitly by whether a request body is present.

```
POST /pipeline_sync  (no body)           → backfill
POST /pipeline_sync  (NDJSON body)       → push/event handling
```

This overloading makes `/pipeline_sync` harder to reason about:
- Callers must know the body-presence convention.
- The source connector must handle both "read from API" and "process input
  events" through the same `read()` method.
- Limits (state_limit, time_limit) apply to both modes but have different
  semantics — backfill may time out mid-page, while event handling processes
  a finite batch.

---

## Proposed Change

Add a new endpoint `/pipeline_handle_events` that owns push-mode event
handling. `/pipeline_sync` becomes backfill-only (no input parameter).

### `/pipeline_handle_events`

Accepts a batch of events and writes them through the pipeline to the
destination. The source connector transforms events into records; the engine
writes them to the destination.

```
POST /pipeline_handle_events
Content-Type: application/x-ndjson

{"type":"source_input","source_input":{"id":"evt_1","type":"customer.created","data":{...}}}
{"type":"source_input","source_input":{"id":"evt_2","type":"customer.updated","data":{...}}}
```

Or with JSON body:

```
POST /pipeline_handle_events
Content-Type: application/json

{
  "pipeline": { "source": {...}, "destination": {...}, "streams": [...] },
  "events": [
    {"id":"evt_1","type":"customer.created","data":{...}},
    {"id":"evt_2","type":"customer.updated","data":{...}}
  ]
}
```

Response: NDJSON stream of destination output (same as `/pipeline_sync`).

---

## Types

### Request (JSON body mode)

```ts
type HandleEventsBody = {
  pipeline: PipelineConfig
  events: unknown[]              // raw event payloads (connector-specific)
  state?: SyncState              // optional: resume state for idempotency
}
```

### Request (NDJSON mode — headers + body)

- `X-Pipeline` header: `PipelineConfig`
- `X-State` header (optional): `SyncState`
- Body: NDJSON lines of `{"type":"source_input","source_input":<payload>}`

### Response

Same `SyncOutput` stream as `/pipeline_sync`: destination messages (state,
log, trace) plus an `eof`/`end` terminal message.

---

## Engine Interface

Add a new method to the `Engine` interface:

```ts
interface Engine {
  // existing
  pipeline_sync(pipeline, opts?, input?): AsyncIterable<SyncOutput>

  // new — dedicated event handler
  pipeline_handle_events(
    pipeline: PipelineConfig,
    events: AsyncIterable<unknown>,
    opts?: { state?: SyncState }
  ): AsyncIterable<SyncOutput>
}
```

Internally, `pipeline_handle_events` does the same thing as today's push-mode
`pipeline_sync`: passes events as the `input` iterable to the source
connector's `read()`. The difference is API clarity — callers don't need to
know about body-presence conventions.

---

## Behavioral Differences from Backfill

| Concern | `/pipeline_sync` (backfill) | `/pipeline_handle_events` |
|---|---|---|
| Source reads from | Upstream API | Provided events |
| Input body | None (ignored) | Required |
| time_limit | Applies (may cut mid-page) | Not applicable (processes full batch) |
| state_limit | Applies | Optional (events are typically small batches) |
| Typical caller | Scheduler / cron | Webhook receiver / event bus |

---

## Why This Might Make Sense

1. **Explicit intent** — callers declare whether they're backfilling or
   handling events. No ambiguity from body presence.
2. **Different SLAs** — event handling is latency-sensitive (webhook → DB in
   < 1s). Backfill is throughput-optimized. Separate endpoints enable
   different timeout/retry/scaling policies.
3. **Simpler source contract** — sources can implement `read()` (API pull)
   and `handleEvents()` (push transform) as distinct methods rather than
   overloading one method with an optional input parameter.
4. **Cleaner `/pipeline_sync`** — removing the input parameter makes
   backfill-only sync easier to document, test, and optimize.

---

## Possible Migration Path

If we decide to go this route:

1. Add `pipeline_handle_events` to the `Engine` interface — initially
   delegates to `pipeline_read(pipeline, { state }, events)` internally.
2. Add the `/pipeline_handle_events` route in `app.ts`, accepting both JSON
   body and NDJSON modes.
3. Update callers (webhook handlers, event bus consumers) to use the new
   endpoint.
4. Remove the `input` parameter from `pipeline_sync` and its route handler.
5. (Optional) Add a dedicated `Source.handleEvents()` method for connectors
   that want to separate pull vs push logic.

---

## Open Questions

- Is the current overloading actually causing problems, or is it fine in
  practice?
- Should event handling even go through the source connector, or could the
  engine transform events directly into destination records?
- Is `/pipeline_handle_events` the right name, or something like
  `/pipeline_push` or `/pipeline_ingest`?
