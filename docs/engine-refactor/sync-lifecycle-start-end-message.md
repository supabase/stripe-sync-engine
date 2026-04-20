# Sync Lifecycle — Start/End Messages

Replacing the current JSON-body params approach with inline `start`/`end`
messages on the NDJSON stream.

> **Status:** Future design. Not yet implemented.

---

## Current State

Today, `/pipeline_read` and `/pipeline_sync` accept configuration via either:

1. **JSON body** — `{ pipeline, state?, body? }` with `Content-Type: application/json`
2. **Headers** — `X-Pipeline` (pipeline config) + `X-State` (sync state)

The engine terminates the stream with an `eof` message:

```json
{"type":"eof","eof":{"reason":"complete","state":{...},"global_progress":{...},"stream_progress":{...}}}
```

The client must assemble all params before the HTTP request and parse `eof` to
know why the stream ended and what state to resume from.

---

## Proposed Change

Replace the out-of-band params (JSON body / headers) with an inline `start`
message as the first line of the NDJSON stream, and replace `eof` with a
corresponding `end` message as the last line.

### Why

- **Uniform wire format** — everything is a message on the stream. No special
  content-type switching or header encoding.
- **Symmetric** — `start` is the request, `end` is the response. Easier to
  reason about in multi-request continuation loops.
- **Enables continuation** — `end.has_more` + `end.ending_state` gives the
  client exactly what it needs to send the next `start`.

---

## Messages

### `start` — client → engine (first line of request body)

Carries everything currently passed via JSON body or headers:

```ts
type StartPayload = {
  pipeline: PipelineConfig // was: JSON body `pipeline` or X-Pipeline header
  state?: SyncState // was: JSON body `state` or X-State header
  state_limit?: number // was: query param ?state_limit
  time_limit?: number // was: query param ?time_limit
}
```

The client writes exactly one `start` message as the first NDJSON line. Any
subsequent lines are source input messages (webhook events in push mode).

### `end` — engine → client (last line of response body)

Replaces the current `eof` message:

```ts
type EndPayload = {
  reason: 'complete' | 'state_limit' | 'time_limit' | 'error' | 'aborted'
  has_more: boolean // new: signals whether to continue
  ending_state: SyncState // renamed from eof.state
  request_progress: TraceProgress // renamed from eof.global_progress
}
```

#### Mapping from current `eof`

| Current `EofPayload` field | New `EndPayload` field | Notes                                        |
| -------------------------- | ---------------------- | -------------------------------------------- |
| `reason`                   | `reason`               | Same enum                                    |
| `state`                    | `ending_state`         | Renamed for clarity                          |
| `global_progress`          | `request_progress`     | Same `TraceProgress` shape                   |
| `stream_progress`          | `stream_progress`      | Unchanged                                    |
| `cutoff`                   | _(dropped)_            | Folded into `reason` semantics               |
| `elapsed_ms`               | _(moved)_              | Available in `request_progress.elapsed_ms`   |
| —                          | `has_more`             | **New.** Derived from stream terminal status |

---

## Wire Format

NDJSON. One message per line. The `start` message is the first line of the
request body; `end` is the last line of the response.

```json
{
  "type": "start",
  "start": {
    "pipeline": {
      "source": { "type": "stripe", "api_key": "sk_test_...", "api_version": "2024-04-10" },
      "destination": { "type": "postgres", "connection_string": "..." },
      "streams": [{ "name": "customers", "sync_mode": "incremental" }]
    },
    "state": null,
    "time_limit": 30
  }
}
```

Response stream:

```json
{"type":"record","record":{"stream":"customers","data":{"id":"cus_123"}}}
{"type":"source_state","source_state":{"stream":"customers","data":{"starting_after":"cus_123"}}}
{"type":"end","end":{"reason":"complete","has_more":false,"ending_state":{"source":{"streams":{"customers":{"starting_after":null}},"global":{}},"engine":{}},"request_progress":{"elapsed_ms":3200,"run_record_count":5000,"rows_per_second":1562,"state_checkpoint_count":2},"stream_progress":{"customers":{"status":"complete","run_record_count":5000,"records_per_second":1562}}}}
```

---

## Client Loop

```ts
let state: SyncState | undefined
do {
  const response = await fetch('/pipeline_sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-ndjson' },
    body:
      JSON.stringify({
        type: 'start',
        start: { pipeline, state, time_limit: 30 },
      }) + '\n',
  })

  let end: EndPayload
  for await (const msg of parseNdjson(response.body)) {
    if (msg.type === 'end') end = msg.end
    else handleMessage(msg)
  }

  state = end.ending_state
} while (end.has_more)
```

The client does not interpret source state. It round-trips `ending_state` and
continues until `has_more` is false.

---

## Migration Path

1. Add `StartPayload` and `EndPayload` schemas to `packages/protocol`.
2. Update `/pipeline_read` and `/pipeline_sync` route handlers to accept the
   first NDJSON line as a `start` message (falling back to current JSON
   body/header parsing for backwards compat).
3. Replace `eof` emission in the engine with `end`, computing `has_more` from
   terminal stream status.
4. Deprecate JSON body mode and header-based config passing.
5. Remove `EofPayload` once all callers migrate to `EndPayload`.
