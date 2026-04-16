# Remote Engine Client

## Problem

`createEngine` returns an `Engine` (setup / teardown / check / read / write / sync) that runs
connectors in-process. The HTTP server exposes the same operations at REST endpoints. Callers
that want to use the HTTP engine — tests, service activities, one-off scripts — must manually
build `X-Pipeline` headers, call `fetch`, and parse NDJSON response streams. This logic is
duplicated across every call site and is untyped.

## Solution

### `createRemoteEngine`

```typescript
function createRemoteEngine(engineUrl: string, pipeline: PipelineConfig): Engine
```

Returns an object that satisfies the `Engine` interface and delegates every method to the
corresponding HTTP endpoint. Backed by `openapi-fetch` + types generated from the checked-in
`docs/openapi/engine.json` spec, giving compile-time safety on route paths, header names, and
response shapes.

```typescript
// in-process
const engine = createEngine(config, { source, destination }, stateStore)

// remote — identical interface
const engine = createRemoteEngine('http://localhost:3001', pipeline)

// both work the same way
await engine.setup()
for await (const msg of engine.sync()) { ... }
```

**No opts** — state threading and checkpoint limits are service-layer concerns handled by
`activities.ts`, not part of the `Engine` interface.

Note: `externalState` was already removed from `createEngine` prior to this plan.

## Implementation

### New dependencies (apps/engine)

| Package              | Role                                        |
| -------------------- | ------------------------------------------- |
| `openapi-fetch`      | Typed HTTP client (`createClient<paths>`)   |
| `openapi-typescript` | Dev dep — CLI to regenerate types from spec |

### Type generation

```sh
# in apps/engine package.json scripts:
"generate:types": "openapi-typescript ../../docs/openapi/engine.json -o src/lib/openapi.d.ts"
```

Commit the generated `src/lib/openapi.d.ts`. Regenerate whenever `docs/openapi/engine.json`
changes (same convention as the spec itself — manually regenerate and commit).

### Files modified

| File                            | Change                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `apps/engine/package.json`      | Add `openapi-fetch` dep, `openapi-typescript` devDep, `generate:types` script |
| `apps/engine/src/lib/ndjson.ts` | Add `toNdjsonStream(iter)`                                                    |
| `apps/engine/src/lib/index.ts`  | Export `createRemoteEngine`, `toNdjsonStream`                                 |

### Files created

| File                                        | Purpose                                            |
| ------------------------------------------- | -------------------------------------------------- |
| `apps/engine/src/lib/openapi.d.ts`          | Generated types from `docs/openapi/engine.json`    |
| `apps/engine/src/lib/remote-engine.ts`      | `createRemoteEngine` implementation                |
| `apps/engine/src/lib/remote-engine.test.ts` | Integration tests against a real in-process server |

### `toNdjsonStream`

Add to `ndjson.ts`:

```typescript
export function toNdjsonStream(iter: AsyncIterable<unknown>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const item of iter) {
          controller.enqueue(enc.encode(JSON.stringify(item) + '\n'))
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}
```

### `createRemoteEngine`

```typescript
import createClient from 'openapi-fetch'
import type { paths } from './openapi.js'
import type { Engine } from './engine.js'
import { parseNdjsonStream, toNdjsonStream } from './ndjson.js'
import type { CheckResult, DestinationOutput, Message, PipelineConfig } from '@stripe/sync-protocol'

export function createRemoteEngine(engineUrl: string, pipeline: PipelineConfig): Engine {
  const client = createClient<paths>({ baseUrl: engineUrl })
  const ph = JSON.stringify(pipeline)

  return {
    async setup() {
      const { response, error } = await client.POST('/setup', {
        params: { header: { 'x-pipeline': ph } },
      })
      if (error) throw new Error(`/setup failed: ${JSON.stringify(error)}`)
      if (response.status === 204) return undefined
      return response.json()
    },

    async teardown() {
      const { error } = await client.POST('/teardown', {
        params: { header: { 'x-pipeline': ph } },
      })
      if (error) throw new Error(`/teardown failed: ${JSON.stringify(error)}`)
    },

    async check() {
      const { data, error } = await client.GET('/check', {
        params: { header: { 'x-pipeline': ph } },
      })
      if (error) throw new Error(`/check failed: ${JSON.stringify(error)}`)
      return data as { source: CheckResult; destination: CheckResult }
    },

    async *read(input?: AsyncIterable<unknown>) {
      const body = input ? toNdjsonStream(input) : undefined
      const { response } = await client.POST('/read', {
        params: {
          header: body
            ? { 'x-pipeline': ph, 'content-type': 'application/x-ndjson' }
            : { 'x-pipeline': ph },
        },
        body: body as any,
        parseAs: 'stream',
        ...(body ? { duplex: 'half' } : {}),
      } as any)
      if (!response.ok) throw new Error(`/read failed (${response.status})`)
      yield* parseNdjsonStream<Message>(response.body!)
    },

    async *write(messages: AsyncIterable<Message>) {
      const body = toNdjsonStream(messages)
      const { response } = await client.POST('/write', {
        params: { header: { 'x-pipeline': ph, 'content-type': 'application/x-ndjson' } },
        body: body as any,
        parseAs: 'stream',
        duplex: 'half',
      } as any)
      if (!response.ok) throw new Error(`/write failed (${response.status})`)
      yield* parseNdjsonStream<DestinationOutput>(response.body!)
    },

    async *sync(input?: AsyncIterable<unknown>) {
      const body = input ? toNdjsonStream(input) : undefined
      const { response } = await client.POST('/sync', {
        params: {
          header: body
            ? { 'x-pipeline': ph, 'content-type': 'application/x-ndjson' }
            : { 'x-pipeline': ph },
        },
        body: body as any,
        parseAs: 'stream',
        ...(body ? { duplex: 'half' } : {}),
      } as any)
      if (!response.ok) throw new Error(`/sync failed (${response.status})`)
      yield* parseNdjsonStream<DestinationOutput>(response.body!)
    },
  }
}
```

Note on `duplex: 'half'`: required in Node 18+ when the fetch request body is a `ReadableStream`.
Passed via spread since TypeScript's `RequestInit` doesn't declare it. `openapi-fetch` forwards
unknown options to the underlying `fetch` call.

### Tests

`remote-engine.test.ts` spins up a real `@hono/node-server` on port 0 (already a dep),
creates `createRemoteEngine` pointing at `http://localhost:{port}`, and verifies all six
methods using the `sourceTest` / `destinationTest` connectors.

```typescript
let server: ReturnType<typeof serve>
let engineUrl: string

beforeAll(async () => {
  const app = createApp(resolver)
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      engineUrl = `http://localhost:${info.port}`
      resolve()
    })
  })
})

afterAll(
  () =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
)
```

Test coverage: setup / teardown / check / read(input) / write(messages) / sync(input) / HTTP error.

## Verification

```sh
cd apps/engine
pnpm run generate:types    # regenerate openapi.d.ts from engine.json
pnpm test                  # all tests pass including remote-engine.test.ts
pnpm build                 # typecheck passes
```
