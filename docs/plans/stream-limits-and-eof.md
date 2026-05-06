# Stream Limits and EOF Terminal Message

## Problem

The sync workflow is slow because `stateLimit: 1` means one page per Temporal activity invocation — massive overhead per page (activity scheduling, HTTP connection, connector instantiation). The `X-State-Checkpoint-Limit` header is awkwardly named and only supports count-based limits.

## Solution

Replace `X-State-Checkpoint-Limit` header with two query parameters and add an `eof` terminal message:

- `?state_limit=N` — stop after N state messages (count-based)
- `?time_limit=N` — stop after N seconds (time-based, any message boundary)
- `eof` message — last line of every NDJSON response, tells client why stream ended

### EOF message

Every NDJSON streaming response (`/read`, `/sync`) ends with an `eof` message:

```jsonl
{"type":"record","stream":"customers","data":{"id":"cus_1"},"emitted_at":"..."}
{"type":"state","stream":"customers","data":{"cursor":"cus_1"}}
{"type":"eof","reason":"state_limit"}
```

Reasons:

- `complete` — source exhausted, all data read/written
- `state_limit` — hit `?state_limit=N`
- `time_limit` — hit `?time_limit=N`
- `error` — fatal error stopped the stream

### Why server-side limits (not client-side cancellation)

HTTP streaming is server-push — the server drives the pipeline and writes NDJSON to the socket. TCP backpressure is byte-level, not message-level. Client-side cancellation means the server could be several pages ahead, doing wasted Stripe API calls and Postgres writes whose state the client won't capture. Server-side limits stop cleanly at the right boundary with no wasted work.

### Why `eof` instead of just closing the stream

Every mature streaming protocol needs an explicit terminal signal because transport-level EOF is ambiguous (success vs error vs truncation). Comparable prior art: gRPC trailing metadata with status, OpenAI's `data: [DONE]`, GraphQL subscriptions' `complete` message, JS Iterator's `{ done: true }`.

## Future

Unify all connector operations (spec, discover, check) to use NDJSON streaming — currently these are simple request/response methods, but a unified NDJSON protocol (like Airbyte's) simplifies middleware and tooling.
