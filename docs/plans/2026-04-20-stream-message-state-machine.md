# Stream Message State Machine

## Context

Our HTTP streaming endpoints return `200` once the NDJSON stream is established. That is correct at the transport layer, but it leaves a protocol gap:

- a stream can fail after headers are committed
- message ordering is mostly implicit
- clients cannot reliably distinguish "clean completion" from "protocol bug" from "socket closed after a late exception"

We already have the right architectural direction:

- the system is message-first
- stream termination should be explicit (`eof`)
- mid-stream failures must be represented in-band, not as a late HTTP `500`

What is missing is an explicit message lifecycle with validation.

## Problem

Today the stream protocol allows callers to infer broad meaning from message types, but it does not define a strict ordering contract. That creates several failure modes:

1. A producer can emit `progress` before any start/initialization signal.
2. A stream can end on a thrown invariant with only a final `log` line, which is not a machine-readable terminal outcome.
3. Different routes expose slightly different "first valid message" assumptions.
4. Clients have to guess whether a missing `eof` means crash, disconnect, proxy reset, or protocol violation.

This is a protocol problem, not an HTTP problem.

## Goals

- Define a stream-level state machine for all NDJSON streaming routes.
- Make terminal outcomes explicit and machine-readable.
- Convert late exceptions and invariant violations into terminal protocol messages.
- Validate message order on the server so producers cannot emit nonsense silently.
- Give clients deterministic semantics for stream start, progress, success, and failure.

## Non-Goals

- Replace HTTP streaming with WebSockets or gRPC.
- Redesign every message type in one pass.
- Introduce route-specific ad hoc ordering rules without a shared abstraction.

## Design

### Lifecycle phases

Every streaming route should follow the same high-level lifecycle:

```text
prelude -> streaming -> terminal
```

Definitions:

- `prelude`: initial handshake / metadata before steady-state data flow
- `streaming`: normal in-flight messages
- `terminal`: exactly one terminal message, then end of stream

### Route-level first-message policy

Different routes legitimately have different first messages. We should not force a single literal `started` envelope everywhere if a route already has a natural prelude.

Instead, define the validator in terms of allowed message classes per route:

- `/pipeline_check`
  - prelude: `log`, `connection_status`
  - terminal: `connection_status` with `failed`, or `eof`
- `/source_discover`
  - prelude: `log`, `catalog`
  - terminal: `eof`
- `/pipeline_read`
  - prelude: `log`, `catalog`, `stream_status(start)`
  - streaming: `record`, `source_state`, `stream_status`, `progress`, `log`
  - terminal: `eof`, terminal `error`
- `/pipeline_write`
  - prelude: `log`
  - streaming: `source_state`, `progress`, `log`
  - terminal: `eof`, terminal `error`
- `/pipeline_sync`
  - prelude: `log`, `catalog`, `stream_status(start)`, `progress`
  - streaming: `source_state`, `stream_status`, `progress`, `control`, `log`
  - terminal: `eof`, terminal `error`

This preserves existing message shapes while making ordering explicit.

### Terminal semantics

There must be an explicit terminal message for every successful or failed stream.

Two valid designs:

1. Extend `eof` to carry terminal status.
2. Add a dedicated top-level `error` message and keep `eof` success-oriented.

Recommendation: extend `eof`.

Rationale:

- we already use `eof` as the canonical last message
- clients already look for it
- a single terminal envelope avoids "did I get `error` and then also expect `eof`?"

Proposed shape:

```ts
type EofReason = 'complete' | 'state_limit' | 'time_limit' | 'aborted' | 'error'

interface EofPayload {
  reason: EofReason
  has_more: boolean
  ending_state?: SyncState
  run_progress: ProgressPayload
  request_progress: ProgressPayload
  error?: {
    code: 'protocol_violation' | 'invariant_violation' | 'internal_error'
    message: string
  }
}
```

Rules:

- `reason: 'complete'` => normal exhaustion, `has_more: false`
- `reason: 'state_limit' | 'time_limit'` => bounded pause, `has_more: true`
- `reason: 'aborted'` => client disconnect / cancellation, usually `has_more: true`
- `reason: 'error'` => fatal stream failure, `has_more: false`
- `error` field is present only when `reason === 'error'`

### Validation rules

Introduce a stream validator wrapper with explicit phase tracking.

Pseudo-interface:

```ts
interface StreamProtocolSpec<T extends { type: string }> {
  allow_in_prelude(msg: T): boolean
  allow_in_streaming(msg: T): boolean
  is_terminal(msg: T): boolean
  on_violation(details: ViolationDetails): T
  on_thrown_error(err: unknown): T
}
```

Core rules:

- first emitted message must be allowed in `prelude`
- once a steady-state message appears, phase becomes `streaming`
- terminal message is allowed exactly once
- no messages after terminal
- a violation is converted into a terminal protocol message
- a thrown exception is converted into a terminal protocol message

This wrapper should sit at the API boundary, not inside every connector.

## Protocol Changes

### 1. Make EOF reason explicit

Update `packages/protocol/src/protocol.ts`:

- add `reason` to `EofPayload`
- add optional terminal `error` payload for `reason: 'error'`

This aligns the implementation with the existing EOF design intent already documented in `docs/plans/stream-limits-and-eof.md`.

### 2. Add shared validator helper

Add a protocol or engine helper such as:

- `packages/protocol/src/stream-validator.ts`, or
- `apps/engine/src/lib/stream-validator.ts`

Responsibilities:

- track lifecycle phase
- validate message ordering
- map violations to terminal `eof`
- map thrown errors to terminal `eof`

### 3. Normalize API error mapping

Update the streaming response wrappers so that:

- pre-stream failures still return `4xx/5xx`
- post-stream failures become terminal `eof(reason='error')`
- bare "log-only" terminal failures are no longer the primary machine contract

`log` messages can still accompany the terminal `eof`, but they are supplemental.

## Implementation Plan

### Phase 1: Protocol schema

Files:

- `packages/protocol/src/protocol.ts`
- `packages/protocol/src/helpers.ts`
- `packages/protocol/src/index.ts`

Changes:

- extend `EofPayload` with `reason`
- add optional structured `error`
- add helper constructor for terminal error EOF if useful

### Phase 2: Engine-level validator

Files:

- `apps/engine/src/lib/stream-validator.ts` (new)
- `apps/engine/src/api/helpers.ts`
- `packages/ts-cli/src/ndjson.ts`

Changes:

- implement phase-tracking wrapper
- route thrown exceptions through terminal `eof(reason='error')`
- keep existing log emission, but ensure terminal EOF is always last

### Phase 3: Apply per-route specs

Files:

- `apps/engine/src/api/app.ts`
- `apps/service/src/api/app.ts`

Changes:

- wrap streaming iterables with route-specific protocol specs
- define allowed prelude/streaming/terminal message sets per endpoint

### Phase 4: Client and workflow handling

Files:

- `apps/service/src/temporal/activities/_shared.ts`
- `apps/service/src/cli/pipeline-sync.tsx`
- any consumers that currently assume `has_more` is the only EOF signal

Changes:

- teach consumers to inspect `eof.reason`
- treat `reason: 'error'` as failure even though HTTP status is `200`
- preserve `ending_state` behavior for resumable bounded runs

## Example

Successful bounded sync:

```jsonl
{"type":"log","log":{"level":"info","message":"starting sync"}}
{"type":"progress","progress":{"derived":{"status":"started"}}}
{"type":"source_state","source_state":{"state_type":"stream","stream":"customers","data":{"cursor":"cus_123"}}}
{"type":"eof","eof":{"reason":"time_limit","has_more":true,"ending_state":{},"run_progress":{},"request_progress":{}}}
```

Invariant violation after streaming started:

```jsonl
{"type":"log","log":{"level":"info","message":"starting sync"}}
{"type":"progress","progress":{"derived":{"status":"started"}}}
{"type":"eof","eof":{"reason":"error","has_more":false,"error":{"code":"invariant_violation","message":"progress emitted before stream start"},"ending_state":{},"run_progress":{},"request_progress":{}}}
```

Protocol violation from producer:

```jsonl
{
  "type": "eof",
  "eof": {
    "reason": "error",
    "has_more": false,
    "error": {
      "code": "protocol_violation",
      "message": "record not allowed in prelude"
    },
    "ending_state": {},
    "run_progress": {},
    "request_progress": {}
  }
}
```

## Testing

Add unit tests for:

- valid prelude -> streaming -> terminal sequences
- `progress` before allowed prelude
- duplicate terminal messages
- messages after terminal
- thrown exception after several successful messages
- client disconnect path emits `aborted` or terminates consistently by route contract

Likely files:

- `packages/ts-cli/src/ndjson.test.ts`
- `apps/engine/src/api/app.test.ts`
- `apps/engine/src/lib/engine.test.ts`
- new validator-specific tests

## Rollout Notes

- This should be backward-compatible where possible, but adding required `eof.reason` changes the wire contract.
- If needed, ship in two steps:
  1. add `reason` as optional and emit it everywhere
  2. make `reason` required after all consumers are updated

## Open Questions

1. Do we want an explicit `started` message eventually, or are route-specific preludes sufficient for v1?
2. Should `aborted` produce an `eof`, or is disconnect inherently best-effort?
3. Should protocol violations be visible to clients only as terminal `eof(reason='error')`, or also mirrored as `log(level='error')` for operator visibility?
4. Should non-sync routes (`check`, `discover`, `setup`, `teardown`) all adopt `eof` as well for full consistency?

## Recommendation

Implement the validator and explicit `eof.reason` first.

That is the minimum change that solves the real problem:

- `200` remains the correct HTTP status for an established stream
- late failures become explicit protocol outcomes
- stream ordering becomes enforceable instead of implied
