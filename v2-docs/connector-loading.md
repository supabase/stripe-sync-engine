# Connector Loading

How the engine finds, loads, and communicates with connectors across runtimes.

## The problem

A connector is a TypeScript module with a default export satisfying the `Source` or `Destination` interface. The engine needs to load it at runtime. Depending on the execution context, "load" means different things:

| Context                | Runtime | Module resolution                           | How connectors are found                 |
| ---------------------- | ------- | ------------------------------------------- | ---------------------------------------- |
| CLI (local dev)        | Node    | `node_modules` via pnpm                     | `import('@stripe/source-stripe')`        |
| API server             | Node    | same                                        | same                                     |
| Supabase edge function | Deno    | `npm:` specifiers, no `node_modules`        | Bundled at build time via `?raw` imports |
| Cloudflare Worker      | workerd | Bundled at build time                       | esbuild/wrangler bundles everything      |
| Bun                    | Bun     | `node_modules` (npm-compatible)             | `import('@stripe/source-stripe')`        |
| Subprocess             | Any     | Child process resolves from its own context | `npx source-stripe read --config ...`    |

## Loading modes

### 1. In-process dynamic import (current default)

```
engine → import(specifier) → connector module → call methods directly
```

`loadConnector()` in `stateless-sync/src/loader.ts` does `import(packageName)`, validates the export against the Source/Destination contract, and returns the connector object. The engine calls methods directly with full type safety and zero serialization overhead.

**Pros:** Fast (no IPC), typed, debuggable, single process.

**Cons:** The `import()` resolves from the engine package's `node_modules`, not the caller's. In pnpm strict mode, the engine package must list every loadable connector as a dependency — even if the CLI app already depends on both. This is the bug that motivated the CLI wrapper work.

**Used by:** `apps/stateless` (CLI + API), `apps/stateful` (CLI + API), unit/integration tests.

### 2. Build-time bundling (Supabase/Deno)

```
tsup build → ?raw import → esbuild bundles connector source → string constant
             → nodePrefixBuiltinsPlugin rewrites bare → npm: specifiers
             → deployed edge function has connector code inlined
```

Supabase edge functions run on Deno. There's no `node_modules` directory and no dynamic `import()` at deploy time. Instead, `tsup.config.ts` uses the `rawTsBundledPlugin` to:

1. Resolve `?raw` imports of edge function `.ts` files
2. Bundle them with esbuild (including all transitive deps like `source-stripe`, `destination-postgres`)
3. Rewrite bare specifiers to `npm:` (Deno's registry protocol) via `nodePrefixBuiltinsPlugin`
4. Emit the bundled code as a string constant

The edge function is self-contained — no module resolution at runtime.

**Pros:** Works on Deno without `node_modules`. Zero runtime resolution. Validated by the bundle size smoke test.

**Cons:** Connector code is frozen at build time. Source TypeScript is invisible to `tsc` (behind `@ts-ignore`). Errors only surface at deploy/invoke time. Private workspace packages cannot be resolved via `npm:` specifiers — everything must be inlined.

**Used by:** `apps/supabase` (edge functions for webhook, backfill worker, setup).

### 3. Subprocess via NDJSON (new, via `@stripe/protocol/cli`)

```
engine → spawn('npx source-stripe read --config ...')
       → stdout: NDJSON messages
       → stdin: NDJSON destination input (for write)
```

Each connector ships a `bin` entrypoint (`src/bin.ts`) that calls `runConnectorCli()`. The engine spawns the connector as a child process and communicates via NDJSON on stdin/stdout. Module resolution happens naturally from the project root — the child process resolves imports from its own package's `node_modules`.

**Pros:** Solves pnpm strict mode resolution. Runtime-agnostic (any process that speaks NDJSON). Natural isolation (crash doesn't take down the engine). Language-agnostic (a Python connector could speak the same protocol).

**Cons:** Serialization overhead (JSON parse/stringify per message). No shared memory. Harder to debug (two processes). Startup latency (process spawn + module load).

**Used by:** Not yet wired into the engine. Connectors have bin entrypoints ready. The subprocess adapter (spawn + NDJSON pipe wrapper) is the next piece.

## Runtime considerations

### Node

The primary runtime. All three loading modes work. In-process is the default for performance; subprocess is available as a fallback for resolution issues or isolation.

Key constraint: pnpm strict mode means `import(specifier)` resolves from the calling package's `node_modules`, not the project root. This is why `loadConnector()` in `stateless-sync` requires every loadable connector as a direct dependency.

The subprocess mode sidesteps this — `npx source-stripe` resolves from the project root's `node_modules`.

### Deno (Supabase edge functions)

Deno has no `node_modules`. Module resolution uses URL-based imports:

- `npm:stripe` — resolves from Deno's npm registry cache
- `node:fs` — Node built-in compatibility layer
- `https://deno.land/...` — URL imports

Connectors can't be dynamically loaded at runtime in Deno edge functions. The only viable strategy is **build-time bundling**: the connector's source code is compiled into the edge function's bundle with all bare specifiers rewritten to `npm:` or `node:` form.

Private workspace packages (anything with `"private": true` in package.json) can never be resolved via `npm:` — they aren't published to any registry. All code a Deno edge function needs must be inlined at build time.

For the subprocess path, Deno can't `npx` (no npm CLI), but it could spawn a Node subprocess or use `deno run npm:source-stripe`. This is theoretical — edge functions can't spawn child processes anyway.

**Bottom line:** Deno edge functions = build-time bundle only. No dynamic loading, no subprocess.

### Bun

Bun implements Node's module resolution algorithm and reads `node_modules` directly. `import('@stripe/source-stripe')` works the same as Node, with the same pnpm strict mode constraints.

Bun-specific considerations:

- **In-process:** Works identically to Node. `loadConnector()` resolves from the calling package's `node_modules`. Same pnpm strict mode issue applies.
- **Subprocess:** `bunx source-stripe read --config ...` is Bun's equivalent of `npx`. Resolves from project root. NDJSON protocol is runtime-agnostic.
- **Performance:** Bun's faster startup makes the subprocess path less costly than in Node. The spawn + module load overhead that makes subprocess unattractive in Node is significantly reduced.

Bun does not need build-time bundling — it handles `node_modules` natively. The in-process and subprocess paths both work.

### Cloudflare Workers (workerd)

Like Deno, no `node_modules` at runtime. All code must be bundled at build time (typically via wrangler/esbuild). The same `rawTsBundledPlugin` approach used for Supabase would work — bundle the connector into the worker's entry file.

Workers can't spawn child processes, so the subprocess path is unavailable.

Workers have a 1MB code size limit (10MB on paid plans), which constrains how many connectors can be bundled into a single worker.

**Bottom line:** Workers = build-time bundle only. Same as Deno edge functions.

## Resolution flow

```
user provides: "stripe"
                 │
                 ▼
         resolveSpecifier()
     "stripe" → "@stripe/source-stripe"
                 │
                 ▼
         ┌───────┴───────┐
         │               │
    in-process      subprocess
         │               │
  import(specifier)   spawn("npx source-stripe ...")
         │               │
    validate shape    NDJSON on stdin/stdout
         │               │
    Source object      SubprocessSource adapter
         │               │
         └───────┬───────┘
                 │
                 ▼
          engine.run()
```

The `ConnectorResolver` abstraction (in `stateless-sync/src/loader.ts`) is the right place to add the subprocess fallback:

1. Try in-process `import()` first (fast path)
2. If `ERR_MODULE_NOT_FOUND` and subprocess available, fall back to `spawn()` with a `SubprocessSource`/`SubprocessDestination` adapter
3. If `installFn` is provided, try auto-install before falling back

## The subprocess adapter (not yet built)

The missing piece that connects `@stripe/protocol/cli` to the engine:

```ts
// Hypothetical API
function spawnSource(command: string, args: string[]): Source {
  return {
    spec() {
      /* spawn <cmd> spec, parse JSON from stdout */
    },
    async check(params) {
      /* spawn <cmd> check --config <json>, parse result */
    },
    async discover(params) {
      /* spawn <cmd> discover --config <json> */
    },
    async *read(params) {
      /* spawn <cmd> read --config <json> --catalog <json>,
                              yield* parseNdjsonChunks(child.stdout) */
    },
  }
}

function spawnDestination(command: string, args: string[]): Destination {
  return {
    spec() {
      /* spawn <cmd> spec */
    },
    async check(params) {
      /* spawn <cmd> check --config <json> */
    },
    async *write(params, $stdin) {
      /* spawn <cmd> write --config <json> --catalog <json>
         pipe $stdin as NDJSON to child.stdin
         yield* parseNdjsonChunks(child.stdout) */
    },
  }
}
```

The adapter returns a normal `Source`/`Destination` object — the engine doesn't know or care whether it's in-process or subprocess. This is the protocol's value: the interface is the same, only the transport changes.

## Decision matrix

| Question                              | Answer                                               |
| ------------------------------------- | ---------------------------------------------------- |
| Local dev, single machine?            | In-process (fast, debuggable)                        |
| pnpm strict mode breaking `import()`? | Subprocess, or add connector as direct dep           |
| Deno / Cloudflare Worker?             | Build-time bundle                                    |
| Need language-agnostic connectors?    | Subprocess (NDJSON protocol)                         |
| Need crash isolation?                 | Subprocess                                           |
| Need zero-overhead?                   | In-process                                           |
| CI test runner?                       | In-process (test connectors are in `stateless-sync`) |

## Test connectors

`source-test` and `destination-test` live in `stateless-sync` as in-process utilities. They are passthrough implementations for engine tests — not standalone packages, not usable via subprocess. They exist so tests can wire up full pipelines without network calls or real infrastructure.

They don't need `bin` entrypoints or separate packages because:

- They're only used programmatically in tests
- They have no meaningful `spec` (test-destination has an empty schema)
- They're parameterized via the `$stdin` stream, not config
- Nobody will ever `npx source-test read`

## The `installFn` escape hatch

`loadConnector()` accepts an optional `installFn` callback. When `import()` fails with `ERR_MODULE_NOT_FOUND`, it calls `installFn(specifier)` (e.g., `npm install @stripe/source-stripe`) then retries the import.

This is useful for:

- CLI tools that auto-install connectors on first use
- Development workflows where you want `sync --source stripe --destination postgres` to just work without manual `pnpm add`

The subprocess path makes `installFn` less critical (resolution happens from the project root, not from the engine package), but it remains useful for the in-process path.
