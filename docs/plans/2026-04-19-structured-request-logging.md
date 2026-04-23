# Structured Request Logging

**Status:** Future work (not started)
**Date:** 2026-04-19

## Goal

Track every Stripe API request with structured metadata: method, path, params, status, duration_ms, request_id. Enable:

- Live RPS display in the CLI
- Rate limiter wait time visibility
- Multi-tenant correlation in the service (by sync_id / account_id)

## Design

### Context propagation: AsyncLocalStorage

Use `node:async_hooks` `AsyncLocalStorage` to bind a per-sync context (sync_id, account_id) at the top of `pipeline_sync`. All downstream code — including `buildListFn` in `packages/openapi` — can call `getLogger()` without signature changes.

- Works with Bun (stable since 1.0)
- Works across async generators: context is captured when the generator function is _called_, not when `.next()` is invoked
- Works with `Promise.race` / concurrent patterns in subdivision — promises created inside context retain it
- Watch out: WebSocket `onEvent` callbacks must be registered inside the `als.run()` scope

### Instrumentation point: `buildListFn` in `packages/openapi`

`buildListFn` already closes over `apiPath` and sees `response.status`. It accepts a `fetch` parameter. Two options:

1. **Instrumented fetch** — wrap the `fetch` param at construction time to log method/path/status/duration/request_id
2. **Inline logging** — call `getLogger()` directly inside `buildListFn` after each response

Option 1 also captures `makeClient` requests (events, account, webhooks). Option 2 only covers list pagination.

Recommendation: instrumented fetch, created once per `read()` invocation.

### Log entry shape

```ts
{
  method: 'GET',
  path: '/v1/customers',
  params: { limit: 100, starting_after: 'cus_xyz', created: { gte: 1710000000 } },
  status: 200,
  duration_ms: 142,
  request_id: 'req_BJBACn1FDAJcUM',  // from response header 'request-id'
  rate_limit_wait_ms: 50,             // time spent waiting for rate limiter token
}
```

### Delivery mechanism: protocol LogMessage

Emit as `LogMessage` with structured `data` field (requires extending `LogPayload`):

```ts
// packages/protocol/src/protocol.ts
export const LogPayload = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  data: z.record(z.unknown()).optional(), // NEW
})
```

This works across subprocess boundaries (NDJSON) and in-process equally. The CLI and service both consume the same protocol stream.

### Package placement for logger/context

Options:

- **New `packages/logger`** — both `source-stripe` and `apps/service` depend on it. Clean separation.
- **`packages/protocol`** — avoids a new package but adds pino dep to protocol.

Recommendation: new `packages/logger` with pino + AsyncLocalStorage helpers.

### CLI consumption

The CLI render loop handles `msg.type === 'log'` where `msg.log.data?.message === 'api_request'`:

- Compute rolling-window RPS from the stream of entries
- Optionally render tail of recent requests
- Show cumulative rate_limit_wait_ms

### Multi-tenant service

Service calls `als.run({ sync_id, account_id }, () => engine.pipeline_sync(...))`. All log entries automatically include correlation fields. Standard pino child logger pattern.

## Stripe request_id

Stripe returns a server-side `request-id` response header (already captured via `pickDebugHeaders`). No client-side request ID mechanism exists in the Stripe API — generate our own if needed (transport.ts already does `crypto.randomUUID().slice(0, 8)` for verbose tracing).

## Scope of changes

| Package                  | Change                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `packages/protocol`      | Add `data` field to `LogPayload`                                                              |
| `packages/logger` (new)  | AsyncLocalStorage context + pino child logger helpers                                         |
| `packages/openapi`       | Instrument `buildListFn` to emit request logs                                                 |
| `packages/source-stripe` | Create instrumented fetch in `read()`, bind ALS context, log from `withRateLimit` (wait time) |
| `apps/engine`            | Progress reducer: compute RPS from log stream                                                 |
| `apps/engine` (CLI)      | Render RPS + request tail from log messages                                                   |
| `apps/service`           | Bind sync context at request boundary                                                         |
