# Connector Discovery

The engine supports four levels of connector discovery, each with different trust and convenience tradeoffs. Levels are tried in order — the first match wins.

## Discovery Levels

### Level 1: In-process import

The engine imports the connector as a JavaScript module. The connector runs in the same process as the engine — no subprocess, no serialization overhead.

```ts
import sourceStripe from '@stripe/source-stripe'
import destinationPostgres from '@stripe/destination-postgres'

engine.register('stripe', sourceStripe)
engine.register('postgres', destinationPostgres)
```

**Trust boundary:** Code review. Only connectors compiled into the build can run.

**Use case:** Bundled first-party connectors, serverless deployments (Lambda, Cloud Run) where subprocess overhead is wasteful.

### Level 2: `@stripe/*` from npm

The engine downloads the connector package from npm at runtime, scoped to a trusted namespace.

```sh
# User asks for a connector that isn't bundled
sync-engine sync --source stripe --destination bigquery

# Engine resolves: npx @stripe/destination-bigquery
```

The engine only downloads packages matching a configured scope (default: `@stripe`). This prevents arbitrary code execution — only the scope owner can publish packages.

**Trust boundary:** npm scope ownership. The `@stripe` scope is controlled by Stripe.

**Use case:** CLI tool where zero-setup UX matters. Users don't pre-install connector packages — the engine pulls what it needs.

**Tradeoffs:**

- Requires network access at sync time
- No version pinning (gets latest unless configured)
- Not reproducible — the same command may run different code tomorrow
- Adds startup latency (npm resolution)

### Level 3: Explicit config

The admin maps connector names to commands. The command can be anything — an npm package, a local binary, a script in any language. The engine spawns it as a subprocess and communicates via NDJSON on stdin/stdout.

```json
{
  "connectors": {
    "source-salesforce": "npx @acme/source-salesforce",
    "source-internal": "/opt/bin/source-internal",
    "source-legacy": "python3 /path/to/source.py",
    "destination-snowflake": "docker run --rm snowflake-connector"
  }
}
```

**Trust boundary:** Admin at deploy time. Only commands the admin explicitly declared can run.

**Use case:** Third-party connectors, connectors written in other languages, locked-down production deployments where the admin controls exactly what runs.

**Protocol requirement:** The command must implement the connector CLI protocol — `spec`, `check`, `discover` (sources), `read` (sources), `write` (destinations), `setup`, `teardown` subcommands, communicating via NDJSON on stdin/stdout.

### Level 4: Auto-discover from PATH

The engine scans `$PATH` for binaries matching a naming convention (e.g., `source-*`, `destination-*`) and registers them as connectors.

```sh
# Engine finds these on PATH:
#   source-stripe       → registered as source "stripe"
#   source-salesforce   → registered as source "salesforce"
#   destination-postgres → registered as destination "postgres"
```

At startup, the engine runs `<binary> spec` on each discovered binary to get connector metadata and config schemas.

**Trust boundary:** Machine configuration. Anything on PATH that matches the pattern can run.

**Use case:** Development machines, environments where connectors are installed globally via `npm install -g`.

## Configuration

The `--connector-discovery` flag (or `CONNECTOR_DISCOVERY` env) controls which levels are enabled:

| Mode    | Levels enabled | Description                                           |
| ------- | -------------- | ----------------------------------------------------- |
| `local` | 1, 3, 4        | No network downloads. For Docker, production servers. |
| `all`   | 1, 2, 3, 4     | Full discovery including npm download. For CLI.       |

Default: `all` for CLI, `local` for `serve`.

```sh
# CLI — downloads @stripe/destination-bigquery if needed
sync-engine sync --source stripe --destination bigquery

# Server — only uses bundled, configured, or PATH connectors
sync-engine serve --connector-discovery=local

# Docker — hermetic, no npm at runtime
ENV CONNECTOR_DISCOVERY=local
```

## Resolution order

When the engine needs a connector (e.g., `source "stripe"`):

1. **In-process registry** — check if it was registered via `engine.register()` at startup
2. **Explicit config** — check if the config maps `source-stripe` to a command
3. **PATH discovery** — check if `source-stripe` is on PATH
4. **npm download** (if enabled) — try `npx @stripe/source-stripe`

The first match wins. This means in-process connectors always take priority over subprocess, and explicit config always beats auto-discovery.

## Security summary

| Level               | What can run                      | Who controls it         | Network required |
| ------------------- | --------------------------------- | ----------------------- | ---------------- |
| 1 — In-process      | Compiled-in modules               | Developer (code review) | No               |
| 2 — npm scope       | Packages in `@stripe/*`           | Scope owner (npm)       | Yes              |
| 3 — Explicit config | Admin-declared commands           | Admin (deploy config)   | No\*             |
| 4 — PATH discovery  | Anything matching pattern on PATH | Machine config          | No               |

\*Level 3 commands can themselves require network (e.g., `npx @acme/source-salesforce`), but the engine doesn't initiate the download — the command does.

