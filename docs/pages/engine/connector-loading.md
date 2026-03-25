# Connector Discovery

How the engine finds, loads, and communicates with connectors.

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
       → stdin: NDJSON input (for write or live events)
```

The subprocess adapter (`createSourceFromExec`/`createDestinationFromExec`) wraps the child process as a normal `Source`/`Destination` object. The engine doesn't know or care whether a connector is in-process or subprocess — the interface is identical.

The child process resolves imports from its own package's `node_modules` — pnpm strict mode is irrelevant. Crash isolation is free — a connector OOM or hang doesn't take down the engine.

## Resolution order

When the engine needs a connector (e.g., `source "stripe"`):

1. **Registered** (always) — in-process connector passed at startup. Fastest, no subprocess.
2. **commandMap** — explicit name→command entry in `connectorsFrom.commandMap`.
3. **path** — binary matching `source-<name>` found in `node_modules/.bin` or `PATH`.
4. **npm** — auto-download via `npx @stripe/source-<name>`.

The first match wins. Registered connectors always take priority.

## Strategies

### In-process (registered)

Connectors passed directly at startup. Not configurable via flags — set in code:

```ts
const resolver = createConnectorResolver({
  sources: { stripe: sourceStripe },
  destinations: { postgres: destinationPostgres },
})
```

**Trust boundary:** Code review. Only connectors compiled into the build can run.

**Use case:** Bundled first-party connectors, serverless deployments.

### `connectors-from-command-map`

Explicit name→command mappings. The command can be anything — an npm package, a local binary, a script in any language. The engine spawns it and communicates via NDJSON on stdin/stdout.

```sh
--connectors-from-command-map '{"source-salesforce":"npx @acme/source-salesforce","destination-snowflake":"/opt/bin/dest-snowflake"}'
```

**Trust boundary:** Admin at deploy time. Only commands the admin explicitly declared can run.

**Use case:** Third-party connectors, connectors in other languages, locked-down deployments.

**Protocol requirement:** The command must implement the connector CLI protocol (`spec`, `check`, `discover`, `read`, `write`, `setup`, `teardown` subcommands via NDJSON on stdin/stdout).

### `connectors-from-path`

Scans `node_modules/.bin` and `PATH` for binaries matching `source-<name>` / `destination-<name>`.

```sh
--no-connectors-from-path   # disable
```

**Trust boundary:** Machine configuration. Anything on PATH matching the naming pattern can run.

**Use case:** Development machines, Docker images with connectors pre-installed.

### `connectors-from-npm`

Downloads `@stripe/source-<name>` / `@stripe/destination-<name>` from npm at runtime via `npx`.

```sh
--connectors-from-npm
```

**Trust boundary:** npm scope ownership. Only packages in the `@stripe` scope can be auto-downloaded.

**Use case:** CLI tool where zero-setup UX matters — users don't pre-install connector packages.

**Tradeoffs:**

- Requires network access at sync time
- No version pinning (gets latest unless `npx` cache is pinned)
- Not reproducible — same command may run different code tomorrow

## All three strategies are command strings

Under the hood, all three strategies produce a command string that gets spawned the same way:

| Strategy     | Example command                              |
| ------------ | -------------------------------------------- |
| `commandMap` | `"npx @acme/source-salesforce"`              |
| `path`       | `"/path/to/node_modules/.bin/source-stripe"` |
| `npm`        | `"npx @stripe/source-stripe"`                |

Multi-word commands are split on whitespace at spawn time — `"npx @stripe/source-stripe"` becomes `spawn("npx", ["@stripe/source-stripe", "spec", ...])`.

## CLI flags

| Flag                                   | Description                           |
| -------------------------------------- | ------------------------------------- |
| `--connectors-from-command-map <json>` | Explicit command map (JSON or `@file`) |
| `--no-connectors-from-path`            | Disable PATH-based discovery          |
| `--connectors-from-npm`                | Enable npm auto-download              |

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

Private workspace packages (`"private": true`) can never be resolved via `npm:` — they must be inlined at build time. Only registered (bundled) connectors are available; subprocess is not an option.

### Bun

Same as Node — reads `node_modules` directly. `bunx` is the equivalent of `npx` for subprocess.

### Cloudflare Workers (workerd)

Same as Deno: bundle-only, no subprocess. Workers have a 1MB code size limit (10MB on paid plans) constraining how many connectors can be bundled.

## Security summary

| Strategy   | What can run                      | Who controls it         | Network |
| ---------- | --------------------------------- | ----------------------- | ------- |
| Registered | Compiled-in modules               | Developer (code review) | No      |
| commandMap | Admin-declared commands           | Admin (deploy config)   | No\*    |
| path       | Anything on PATH matching pattern | Machine config          | No      |
| npm        | Packages in `@stripe/*`           | Scope owner (npm)       | Yes     |

\* commandMap entries can themselves require network (e.g., `npx @acme/source-salesforce`), but the engine doesn't initiate the download — the command does.

## Test connectors

`sourceTest` and `destinationTest` stay in `stateless-sync` as in-process utilities. They're passthrough implementations for engine tests — not standalone packages, not subprocess-capable. Registered directly in test setup:

```ts
const resolver = createConnectorResolver({
  sources: { test: sourceTest },
  destinations: { test: destinationTest },
})
```
