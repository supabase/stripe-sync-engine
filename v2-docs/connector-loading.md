# Connector Loading

How the engine finds, loads, and communicates with connectors across runtimes.

## The two loading modes

### In-process (registered)

The app imports connectors statically and registers them with the resolver:

```ts
import source from '@stripe/source-stripe'
import destination from '@stripe/destination-postgres'

const resolver = createConnectorResolver({
  sources: { stripe: source },
  destinations: { postgres: destination },
})
```

No dynamic `import()`, no pnpm resolution issues. The connector is a direct dependency of the app, resolved at build/startup time. The engine calls methods directly — zero serialization, full type safety, debuggable.

### Subprocess (spawned)

Each connector ships a `bin` entrypoint that speaks NDJSON on stdin/stdout. The engine spawns the connector as a child process:

```
engine → spawn('source-stripe read --config ...')
       → stdout: NDJSON messages
       → stdin: NDJSON destination input (for write)
```

The child process resolves imports from its own package's `node_modules` — pnpm strict mode is irrelevant. Crash isolation is free — a connector OOM or hang doesn't take down the engine.

## Resolution strategy

The resolver uses a simple fallback chain:

```
1. Check registered connectors  →  in-process (fast path)
2. Subprocess available?        →  spawn binary (fallback)
3. Neither                      →  error
```

```ts
const resolver = createConnectorResolver({
  // Registered: always available, any runtime
  sources: { stripe: sourceStripe },
  destinations: { postgres: destPostgres },
  // Unregistered connectors: resolved via subprocess if available
})

// Registered → in-process
await resolver.resolveSource('stripe')

// Not registered → spawn 'source-custom read ...'
await resolver.resolveSource('custom')
```

Subprocess availability is auto-detected:

- Can we `import('node:child_process')`? (fails in Deno edge functions, Workers)
- Does the binary exist in PATH / `node_modules/.bin/`?

No config flags. No deployment-aware code. The resolver just falls through.

## The subprocess adapter

Wraps a child process as a normal `Source`/`Destination` object. The engine doesn't know or care whether a connector is in-process or subprocess — the interface is identical.

```ts
function spawnSource(bin: string): Source {
  return {
    spec() {
      // spawn <bin> spec, parse JSON from stdout
    },
    async check(params) {
      // spawn <bin> check --config <json>, parse result
    },
    async discover(params) {
      // spawn <bin> discover --config <json>
    },
    async *read(params) {
      // spawn <bin> read --config <json> --catalog <json>
      // yield* parseNdjsonChunks(child.stdout)
    },
  }
}

function spawnDestination(bin: string): Destination {
  return {
    spec() {
      // spawn <bin> spec
    },
    async check(params) {
      // spawn <bin> check --config <json>
    },
    async *write(params, $stdin) {
      // spawn <bin> write --config <json> --catalog <json>
      // pipe $stdin as NDJSON to child.stdin
      // yield* parseNdjsonChunks(child.stdout)
    },
  }
}
```

## When to use which

The rule: **subprocess when the process outlives the sync.**

A long-running server (stateful API, Docker) needs crash isolation — a connector failure during sync execution shouldn't take down the CRUD plane or other concurrent syncs. Subprocess gives this for free.

A serverless function (Lambda) or CLI is ephemeral — the process dies when the sync ends anyway. In-process is fine; the platform provides isolation.

| Deployment          | Connectors installed | Connector selected          | Loading                                   |
| ------------------- | -------------------- | --------------------------- | ----------------------------------------- |
| Lambda / serverless | Bundle time          | Deploy time (static import) | Registered, in-process                    |
| Docker server       | Image build time     | Request time (sync config)  | Registered first, subprocess fallback     |
| CLI                 | `pnpm add`           | Runtime (user flags)        | Registered first, subprocess fallback     |
| Deno edge / Workers | Bundle time          | Deploy time                 | Registered only (no subprocess available) |
| Tests               | Workspace deps       | Test setup                  | Registered, in-process                    |

## Runtime details

### Node

Primary runtime. Both modes work. Subprocess spawns the connector's `bin` entrypoint from `node_modules/.bin/`.

### Deno (Supabase edge functions)

No `node_modules`, no `child_process`. Connectors must be bundled at build time using the `?raw` import + esbuild pipeline (`rawTsBundledPlugin` in `tsup.config.ts`). The build rewrites bare specifiers to `npm:` / `node:` form via `nodePrefixBuiltinsPlugin`.

Private workspace packages (`"private": true`) can never be resolved via `npm:` — they must be inlined at build time.

Only registered (bundled) connectors are available. Subprocess is not an option.

### Bun

Same as Node — reads `node_modules` directly. `bunx` is the equivalent of `npx` for subprocess. Bun's faster startup makes subprocess less costly than in Node.

### Cloudflare Workers (workerd)

Same as Deno: bundle-only, no subprocess. Workers have a 1MB code size limit (10MB on paid plans) constraining how many connectors can be bundled.

## Build-time bundling (Supabase/Deno detail)

```
tsup build → ?raw import → esbuild bundles connector source → string constant
             → nodePrefixBuiltinsPlugin rewrites bare → npm: specifiers
             → deployed edge function has connector code inlined
```

The edge function is self-contained. No module resolution at runtime. The trade-off: connector code is frozen at build time, source TypeScript is invisible to `tsc` (behind `@ts-ignore`), and errors only surface at deploy/invoke time.

## What goes away

The old `loadConnector()` did `import(packageName)` from within the engine package. This required the engine to list every loadable connector as a dependency (pnpm strict mode) and offered an `installFn` escape hatch for auto-installing missing packages.

With the registered-first + subprocess-fallback strategy:

- **`import(packageName)` in the engine** — gone. The app registers connectors, not the engine.
- **`installFn`** — gone. Subprocess resolves from the project root naturally.
- **Engine listing connectors as dependencies** — gone. Connectors are dependencies of the app, not the engine.

The engine becomes runtime-agnostic. It receives `Source`/`Destination` objects and doesn't care how they were loaded.

## Test connectors

`source-test` and `destination-test` stay in `stateless-sync` as in-process utilities. They're passthrough implementations for engine tests — not standalone packages, not subprocess-capable. Registered directly in test setup:

```ts
const resolver = createConnectorResolver({
  sources: { test: testSource },
  destinations: { test: testDestination },
})
```
