# Client Disconnect Cancellation

**Status:** Not yet implemented — this doc captures research and findings.

## Problem

When an HTTP client disconnects mid-stream (e.g. curl killed, browser tab closed),
the engine continues executing the full pipeline — making Stripe API requests,
writing to Postgres, etc. — until the read completes naturally (via `time_limit`
or source exhaustion). This wastes API quota and compute.

## Goal

When the client disconnects, abort the pipeline as quickly as possible:
stop pulling from the source, stop writing to the destination, tear down
the async generator chain.

## What we tried

### 1. `ReadableStream.cancel()` callback

`ndjsonResponse` creates a `ReadableStream`. The spec says `cancel()` is called
when the consumer cancels the stream. We added an `AbortController` that aborts
in `cancel()`, then used `Promise.race([iterator.next(), abortedPromise])` to
unblock the iteration loop immediately.

**Result:**

- Works under compiled `node` (via `@hono/node-server`'s `writeFromReadableStreamDefaultReader`
  which calls `reader.cancel()` on `writable.close`)
- Does NOT work under `tsx` — `cancel()` never fires
- Does NOT work under `bun` with `@hono/node-server` — `res.close` event never fires on
  client disconnect (only fires after the response completes naturally)

### 2. `Bun.serve()` native

Bun's native `Bun.serve()` (not `@hono/node-server`) properly calls
`ReadableStream.cancel()` on client disconnect. Confirmed with a minimal test script.

**Result:** Works, but only under Bun's native server.

### 3. Node.js `outgoing.on('close')` / `incoming.on('close')`

`@hono/node-server` exposes `c.env.outgoing` (ServerResponse) and `c.env.incoming`
(IncomingMessage). We listened for `close` on both and linked to the AbortController.

**Result:**

- Works under compiled `node` and `tsx`
- Under `bun`, `req.close` and `socket.close` fire at the right time, but
  `res.close` does NOT fire — and the response stream keeps writing.

### 4. `c.req.raw.signal` (Request.signal)

The Fetch API `Request` has a `signal` property. We tried using it as an abort source.

**Result:** Never fires on client disconnect under any runtime tested.

## Key finding: `Promise.race` breaks `remote-engine.test.ts`

Replacing `for await (const item of iterable)` with manual `iterator.next()` +
`Promise.race` caused the `remote-engine.test.ts` test to lose the final `eof`
message. The test expects `[source_state, eof]` but only receives `[source_state]`.

Root cause not fully diagnosed — may be related to:

- Manual `iterator.return()` on a naturally-completed generator interfering with
  the response stream lifecycle
- Unhandled rejection from the `aborted` promise when cancel fires after stream close
- Subtle differences in how `for await...of` vs manual iteration handles stream completion

## Confirmed working (minimal test)

A standalone script confirmed that `Bun.serve()` + `ReadableStream.cancel()` +
`Promise.race` works correctly for cancellation. The issue is specifically in the
interaction between the full engine pipeline, `@hono/node-server`, and the
`ndjsonResponse` helper under real test conditions.

## Recommended next steps

1. **Use `Bun.serve()` in production** — the `index.ts` runtime detection is already
   in place and works. This gives cancellation for free under bun.

2. **Fix the `for await` → `Promise.race` migration** — the `eof` message loss needs
   to be root-caused. Likely needs a more careful teardown sequence that doesn't
   call `iterator.return()` when the generator completed naturally.

3. **Consider passing `AbortSignal` through the engine pipeline** — rather than
   aborting at the `ndjsonResponse` level, pass a signal into `pipeline_read` /
   `pipeline_sync` so the source connector can abort in-flight `fetch()` calls
   directly. This would be the most thorough fix.

4. **For `@hono/node-server` under tsx** — the `outgoing.on('close')` approach
   works but needs the `ndjsonResponse` `Promise.race` fix first.
