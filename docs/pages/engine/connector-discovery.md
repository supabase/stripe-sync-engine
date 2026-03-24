# Connector Discovery

The engine supports three dynamic resolution strategies for connectors that aren't registered in-process. Each strategy is controlled by a dedicated flag, and all three share the same resolution mechanism: they produce a command string that gets spawned as a subprocess.

## Resolution order

When the engine needs a connector (e.g., `source "stripe"`):

1. **Registered** (always) — in-process connector passed at startup. Fastest, no subprocess.
2. **commandMap** — explicit name→command entry in `connectors_from.command_map`.
3. **path** (default: on) — binary matching `source-<name>` found in `node_modules/.bin` or `PATH`.
4. **npm** (default: off) — auto-download via `npx @tx-stripe/source-<name>`.

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

JSON config equivalent:

```json
{
  "connectors_from": {
    "command_map": {
      "source-salesforce": "npx @acme/source-salesforce",
      "destination-snowflake": "/opt/bin/dest-snowflake"
    }
  }
}
```

**Trust boundary:** Admin at deploy time. Only commands the admin explicitly declared can run.

**Use case:** Third-party connectors, connectors in other languages, locked-down deployments.

**Protocol requirement:** The command must implement the connector CLI protocol (`spec`, `check`, `discover`, `read`, `write`, `setup`, `teardown` subcommands via NDJSON on stdin/stdout).

### `connectors-from-path`

Scans `node_modules/.bin` and `PATH` for binaries matching `source-<name>` / `destination-<name>`.

```sh
# Enabled by default — disable with:
--no-connectors-from-path
```

**Trust boundary:** Machine configuration. Anything on PATH matching the naming pattern can run.

**Use case:** Development machines, Docker images with connectors pre-installed.

### `connectors-from-npm`

Downloads `@tx-stripe/source-<name>` / `@tx-stripe/destination-<name>` from npm at runtime via `npx`.

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
| `npm`        | `"npx @tx-stripe/source-stripe"`             |

Multi-word commands are split on whitespace at spawn time — `"npx @tx-stripe/source-stripe"` becomes `spawn("npx", ["@tx-stripe/source-stripe", "spec", ...])`.

## CLI flags

### `sync` / `check` commands

| Flag                                   | Default  | Description                               |
| -------------------------------------- | -------- | ----------------------------------------- |
| `--connectors-from-command-map <json>` | —        | Explicit command map (JSON or `@file`)    |
| `--no-connectors-from-path`            | path: on | Disable PATH-based discovery              |
| `--connectors-from-npm`                | npm: on  | npm auto-download (on by default for CLI) |

### `serve` command

| Flag                                   | Default  | Description                                         |
| -------------------------------------- | -------- | --------------------------------------------------- |
| `--connectors-from-command-map <json>` | —        | Explicit command map (JSON or `@file`)              |
| `--no-connectors-from-path`            | path: on | Disable PATH-based discovery                        |
| `--connectors-from-npm`                | npm: off | Enable npm auto-download (off by default for serve) |

### Defaults by deployment

| Context        | commandMap  | path | npm |
| -------------- | ----------- | ---- | --- |
| `sync`/`check` | from flags  | on   | on  |
| `serve`        | from config | on   | off |
| Serverless     | —           | off  | off |
| Tests          | —           | on   | off |

## Security summary

| Strategy   | What can run                      | Who controls it         | Network |
| ---------- | --------------------------------- | ----------------------- | ------- |
| Registered | Compiled-in modules               | Developer (code review) | No      |
| commandMap | Admin-declared commands           | Admin (deploy config)   | No\*    |
| path       | Anything on PATH matching pattern | Machine config          | No      |
| npm        | Packages in `@tx-stripe/*`        | Scope owner (npm)       | Yes     |

\* commandMap entries can themselves require network (e.g., `npx @acme/source-salesforce`), but the engine doesn't initiate the download — the command does.
