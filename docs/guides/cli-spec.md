# `sync-engine` CLI Specification

## Context

Product-quality CLI for the sync engine with a dead-simple one-liner experience that progressively discloses power. The CLI is stateless — sync state lives in the destination (Postgres `_sync_state` table). Config is JSON-first (agentic-friendly). The CLI is a thin composition root over `@stripe/sync-source-stripe`, `@stripe/sync-destination-postgres`, and `@stripe/sync-engine`.

**Package:** `apps/engine` (`@stripe/sync-engine`).
**Binary:** `sync-engine`

---

## 1. Subcommands

```sh
sync-engine serve [flags]     # start HTTP API server
sync-engine sync [flags]      # run one sync pipeline
sync-engine check [flags]     # validate source + destination connectivity
sync-engine-serve             # start bundled-only HTTP API server
```

`sync-engine` remains the full interactive CLI. `sync-engine-serve` is the minimal
bundled-only server binary for Docker and local dev; it reads `PORT` from the environment
and disables PATH/npm connector discovery.

---

## 2. Flag Reference

### `sync-engine serve`

| Flag                            | Env var | Default | Description                                         |
| ------------------------------- | ------- | ------- | --------------------------------------------------- |
| `--port <n>`                    | `PORT`  |         | Port to listen on                                   |
| `--connectors-from-command-map` |         |         | Explicit connector command mappings (JSON or @file) |
| `--no-connectors-from-path`     |         | false   | Disable PATH-based connector discovery              |
| `--connectors-from-npm`         |         | false   | Enable npm auto-download of connectors              |

### `sync-engine-serve`

| Input      | Default | Description                                                      |
| ---------- | ------- | ---------------------------------------------------------------- |
| `PORT` env | `3000`  | Port to listen on                                                |
| Connectors | bundled | Uses `defaultConnectors` only; dynamic PATH/npm discovery is off |

### `sync-engine sync` / `sync-engine check`

#### Source (Stripe)

| Flag                   | Env var          | Description                                                |
| ---------------------- | ---------------- | ---------------------------------------------------------- |
| `--stripe-api-key`     | `STRIPE_API_KEY` | Stripe API key                                             |
| `--stripe-base-url`    |                  | Override Stripe API base URL                               |
| `--websocket`          |                  | Stay alive for real-time WebSocket events (default: false) |
| `--backfill-limit <n>` |                  | Max objects to backfill per stream                         |

#### Destination (Postgres)

| Flag                | Env var                         | Description                       |
| ------------------- | ------------------------------- | --------------------------------- |
| `--postgres-url`    | `POSTGRES_URL` / `DATABASE_URL` | Postgres connection string        |
| `--postgres-schema` |                                 | Target schema (default: `stripe`) |

#### Sync behavior

| Flag         | Default | Description                                     |
| ------------ | ------- | ----------------------------------------------- |
| `--streams`  |         | Comma-separated stream names to sync            |
| `--no-state` | false   | Skip state loading/saving (always full refresh) |

#### Generic / advanced

| Flag                            | Description                                         |
| ------------------------------- | --------------------------------------------------- |
| `--source`                      | Source connector name (inferred from flags)         |
| `--destination`                 | Destination connector name (inferred from flags)    |
| `--source-config`               | Raw source config JSON or @file                     |
| `--destination-config`          | Raw destination config JSON or @file                |
| `--config`                      | File path or inline JSON with full SyncParams       |
| `--connectors-from-command-map` | Explicit connector command mappings (JSON or @file) |
| `--no-connectors-from-path`     | Disable PATH-based connector discovery              |
| `--connectors-from-npm`         | Enable npm auto-download of connectors              |

---

## 3. Config Resolution

### Precedence (highest → lowest)

1. **CLI flags** — explicit flags always win
2. **`--config` file** — full SyncParams JSON
3. **Environment variables** — `STRIPE_API_KEY`, `POSTGRES_URL`, `DATABASE_URL`, etc.
4. **Built-in defaults** — schema=`stripe`

### `--config` auto-detection

The `--config` flag accepts a file path or inline JSON. If the trimmed value starts with `{`, it's inline JSON; otherwise it's a file path.

```sh
# File path
sync-engine sync --config sync.json

# Inline JSON (agentic use)
sync-engine sync --config '{"source":{"name":"stripe","api_key":"sk_test_..."},...}'
```

---

## 4. Subcommand Details

### `sync-engine sync`

Runs the full pipeline: discover → build catalog → load state → `engine.run()` → persist state.

```sh
# Minimal — Stripe → Postgres, all streams
sync-engine sync \
  --stripe-api-key sk_test_... \
  --postgres-url postgres://localhost/mydb

# Filter streams
sync-engine sync \
  --stripe-api-key sk_test_... \
  --postgres-url postgres://localhost/mydb \
  --streams customer,invoice

# From a JSON config file (SyncParams shape)
sync-engine sync --config sync.json

# Stay alive for live WebSocket events
sync-engine sync \
  --stripe-api-key sk_test_... \
  --postgres-url postgres://localhost/mydb \
  --websocket

# Full refresh (ignore saved state)
sync-engine sync \
  --stripe-api-key sk_test_... \
  --postgres-url postgres://localhost/mydb \
  --no-state
```

**Env var alternatives:**

```sh
export STRIPE_API_KEY=sk_test_...
export DATABASE_URL=postgres://localhost/mydb
sync-engine sync   # picks up from env
```

**Output contract:**

- stdout → NDJSON `StateMessage` lines (checkpoints)
- stderr → logs, errors, stream status
- Exit 0 on success, non-zero on failure

### `sync-engine check`

Validates connectivity to source and/or destination.

```sh
sync-engine check \
  --stripe-api-key sk_test_... \
  --postgres-url postgres://localhost/mydb
# ✓ Source: connected
# ✓ Destination: connected
```

### `sync-engine serve`

Starts the HTTP API server. Accepts sync requests via `POST /sync`.

```sh
sync-engine serve --port 3000

# or use the minimal bundled-only server binary
PORT=3000 sync-engine-serve
```

---

## 5. State Resumption

1. **During sync:** Destination receives `StateMessage` checkpoints, commits records, re-emits confirmed state.
2. **Storage:** CLI persists confirmed state to `{schema}._sync_state` table in Postgres.
3. **On resume:** CLI queries `_sync_state` → builds `SyncParams.state` → passes to engine.
4. **`--no-state`:** Skips state loading and saving (always full refresh).

State is opaque to the CLI — only the source understands the cursor format.

---

## 6. Progressive Disclosure Examples

```sh
# Level 0: env vars, zero flags
export STRIPE_API_KEY=sk_test_abc
export DATABASE_URL=postgres://localhost/mydb
sync-engine sync

# Level 1: explicit flags
sync-engine sync --stripe-api-key sk_test_abc --postgres-url postgres://localhost/mydb

# Level 2: select streams
sync-engine sync \
  --stripe-api-key sk_test_abc \
  --postgres-url postgres://... \
  --streams customer,invoice

# Level 3: live sync, custom schema
sync-engine sync \
  --stripe-api-key sk_test_abc \
  --postgres-url postgres://localhost/mydb \
  --postgres-schema stripe_live \
  --websocket

# Level 4: raw SyncParams JSON file
sync-engine sync --config sync.json

# Level 5: inline JSON (agentic)
sync-engine sync --config '{"source":{"name":"stripe","api_key":"sk_test_abc"},"destination":{"name":"postgres","connection_string":"postgres://localhost/mydb"}}'

# Level 6: programmatic (library, not CLI)
import { createEngine } from '@stripe/sync-engine'
```

---

## 7. Architecture

The CLI is a **thin composition root**:

```
sync-engine sync
  ├─ resolves config (flags + env + config file → SyncParams)
  ├─ imports @stripe/sync-source-stripe
  ├─ imports @stripe/sync-destination-postgres
  ├─ loads state from {schema}._sync_state (PgStateStore)
  ├─ calls engine.run()
  ├─ persists yielded StateMessages to _sync_state
  └─ renders output to stderr/stdout
```

All sync logic stays in `apps/engine/src/lib/`. All connector logic stays in source/destination packages. The CLI owns only: config resolution, state persistence bookkeeping, and output rendering.

### Key files

- `packages/protocol/src/protocol.ts` — `SyncParams`, `Source`, `Destination` interfaces
- `apps/engine/src/lib/engine.ts` — `createEngine()`
- `apps/engine/src/api/app.ts` — `createApp()` — pure Hono app factory
- `apps/engine/src/api/server.ts` — `startApiServer()` — runtime server startup helper
- `apps/engine/src/bin/sync-engine.ts` — full citty/OpenAPI CLI binary
- `apps/engine/src/bin/serve.ts` — bundled-only server binary
- `apps/engine/src/cli/command.ts` — citty `CommandDef` (exported as `"./cli"`)
- `apps/engine/src/cli/sync.ts` — sync command factory
- `packages/source-stripe/src/index.ts` — Source spec, config schema, `read()`
- `packages/destination-postgres/src/index.ts` — Destination spec, config schema, `write()`
