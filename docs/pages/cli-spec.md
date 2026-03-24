# `sync-engine` CLI Specification

## Context

Design a product-quality CLI for the sync engine with a dead-simple one-liner experience that progressively discloses power. The CLI is stateless — sync state lives in the destination. Config is JSON-first (agentic-friendly). The CLI is a thin composition root over the existing `sync-protocol`, `source-stripe`, and `destination-postgres` packages.

**Package:** `apps/sync-engine` (`@stripe/sync-engine`).

---

## 1. Binary Name & Invocation

**Binary:** `sync-engine`

```sh
# Default action = sync (no subcommand)
sync-engine [flags]

# Subcommands
sync-engine init [flags]       # scaffold a config file
sync-engine discover [flags]   # list available streams
sync-engine check [flags]      # validate connectivity
```

The bare `sync-engine` invocation runs the sync pipeline. This is the primary path and must be zero-friction.

---

## 2. Flag Reference

### Connection flags

| Flag                   | Short | Env var           | Default      | Description                  |
| ---------------------- | ----- | ----------------- | ------------ | ---------------------------- |
| `--api-key <key>`      | `-k`  | `STRIPE_API_KEY`  | _(required)_ | Stripe API key               |
| `--postgres-url <url>` | `-d`  | `DATABASE_URL`    | _(required)_ | Postgres connection string   |
| `--schema <name>`      |       | `STRIPE_SCHEMA`   | `stripe`     | Target Postgres schema       |
| `--base-url <url>`     |       | `STRIPE_BASE_URL` |              | Override Stripe API base URL |

### Stream selection

| Flag                       | Short | Default            | Description                             |
| -------------------------- | ----- | ------------------ | --------------------------------------- |
| `--streams <list>`         | `-s`  | _(all discovered)_ | Comma-separated stream names to include |
| `--exclude-streams <list>` |       | _(none)_           | Comma-separated stream names to exclude |

Mutually exclusive — specifying both is an error.

### Sync behavior

| Flag               | Short | Default | Description                                      |
| ------------------ | ----- | ------- | ------------------------------------------------ |
| `--live`           | `-l`  | `false` | After backfill, stream live events via WebSocket |
| `--full-refresh`   |       | `false` | Ignore saved state, re-sync from scratch         |
| `--batch-size <n>` |       | `100`   | Destination write batch size                     |

### Config

| Flag                      | Short | Default | Description                            |
| ------------------------- | ----- | ------- | -------------------------------------- |
| `--config <path-or-json>` | `-c`  |         | Config file path or inline JSON        |
| `--print-config`          |       | `false` | Print resolved config as JSON and exit |

### Output

| Flag              | Short | Default | Description                   |
| ----------------- | ----- | ------- | ----------------------------- |
| `--output <mode>` | `-o`  | `text`  | `text`, `json`, or `quiet`    |
| `--verbose`       | `-v`  | `false` | Show debug-level log messages |

---

## 3. Config Resolution

### Precedence (highest → lowest)

1. **CLI flags** — explicit flags always win
2. **Config file** — values from `--config`
3. **Environment variables** — `STRIPE_API_KEY`, `DATABASE_URL`, etc.
4. **Built-in defaults** — schema=`stripe`, batch_size=100

### Flag → SyncParams mapping

```
CLI flag              → SyncParams field
--api-key             → source_config.api_key
--base-url            → source_config.base_url
--live                → source_config.websocket = true
--postgres-url        → destination_config.connection_string
--schema              → destination_config.schema
--batch-size          → destination_config.batch_size
--streams             → streams[] (each name → {name, sync_mode: 'incremental'})
--exclude-streams     → (filter discovered streams, populate streams[])
--full-refresh        → all streams[].sync_mode = 'full_refresh', skip state loading
```

### Validation

After merge, validate against source `spec()` and destination `spec()` Zod schemas. On failure, print the Zod error and exit code 2. Missing required fields get a clear message:

```
Error: --api-key is required (or set STRIPE_API_KEY)
```

---

## 4. `--config` Auto-Detection

The `--config` flag accepts a file path or inline JSON. Detection rule: if the trimmed value starts with `{`, it's inline JSON. Otherwise it's a file path.

```sh
# File path
sync-engine --config sync.json

# Inline JSON (agentic use)
sync-engine --config '{"source_config":{"api_key":"sk_test_..."},...}'
```

Implementation:

```ts
const config = value.trimStart().startsWith('{')
  ? JSON.parse(value)
  : JSON.parse(fs.readFileSync(value, 'utf8'))
```

No stdin config (`--config -`) — stdin is reserved for data piping in composable scenarios.

---

## 5. `--print-config`

Resolves the full `SyncParams` from all sources, prints as pretty JSON to stdout, exits 0. No sync runs.

```sh
sync-engine --api-key sk_test_abc --postgres-url postgres://localhost/mydb --print-config
```

```json
{
  "source_config": {
    "api_key": "sk_test_abc"
  },
  "destination_config": {
    "connection_string": "postgres://localhost/mydb",
    "schema": "stripe",
    "batch_size": 100
  },
  "streams": [{ "name": "products" }, { "name": "customers" }, { "name": "invoices" }]
}
```

Secrets shown in full — this is a trusted diagnostic tool. The output is a valid config file: save it, edit it, feed it back with `--config`.

---

## 6. Subcommands

### `sync-engine` (default — sync)

Runs the full pipeline: discover → build catalog → load state → `engine.run()` → persist state.

### `sync-engine init`

Calls `source.discover()` and outputs a full `SyncParams` JSON to stdout.

```sh
sync-engine init -k sk_test_abc -d postgres://localhost/mydb > sync.json
# edit sync.json
sync-engine --config sync.json
```

Same output format as `--print-config`. Writes to stdout — redirect to save. Functionally equivalent to `--print-config` but semantically says "I'm starting a new project."

### `sync-engine discover`

Lists available streams from the source.

```sh
sync-engine discover -k sk_test_abc
# products
# customers
# invoices
# ...

sync-engine discover -k sk_test_abc -o json | jq '.streams[].name'
```

### `sync-engine check`

Validates connectivity to source and/or destination.

```sh
sync-engine check -k sk_test_abc -d postgres://localhost/mydb
# source: ok
# destination: ok
```

Exit 0 if all pass, exit 1 if any fail.

---

## 7. Output Behavior

### `text` mode (default)

Human-readable progress on **stderr**. State checkpoints as NDJSON on **stdout**.

```
sync-engine v0.1.0
Syncing 18 streams to postgres://localhost/mydb (schema: stripe)

  products        ✓  47 records
  customers       ✓  1,203 records
  invoices        ...  342 records
  prices          [pending]

Completed: 14/18 streams | 12,847 records | 2m 34s
```

Progress updates in-place when stderr is a TTY. When piped, one line per stream completion.

### `json` mode (`-o json`)

All messages as NDJSON on stdout. Nothing on stderr. For programmatic consumers.

### `quiet` mode (`-o quiet`)

Only errors on stderr. State on stdout. For cron.

### Live mode output

After backfill completes:

```
Backfill complete: 12,847 records in 2m 34s
Streaming live events... (Ctrl-C to stop)

  customer.updated    cus_abc123    0.2s ago
  invoice.created     in_xyz456     1.1s ago
```

---

## 8. Exit Codes

| Code  | Meaning                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------- |
| `0`   | Success — all streams completed                                                                           |
| `1`   | Fatal error — config, connection, or unrecoverable failure                                                |
| `2`   | Invalid usage — bad flags, missing required args, validation failure                                      |
| `3`   | Partial failure — some streams completed, some failed. State saved for completed streams; re-run resumes. |
| `130` | Interrupted (SIGINT) — graceful shutdown: flush buffered records, save state, exit                        |

---

## 9. State Resumption

### How it works

1. **During sync:** Destination receives `StateMessage` checkpoints, commits records, re-emits confirmed state.
2. **Storage:** CLI persists confirmed state to `{schema}._sync_state` table:
   ```sql
   CREATE TABLE IF NOT EXISTS "{schema}"."_sync_state" (
     stream TEXT PRIMARY KEY,
     data JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );
   ```
3. **On resume:** CLI queries `_sync_state` → builds `SyncParams.state` → passes to `runSync()`.
4. **`--full-refresh`:** Skips state loading, clears `_sync_state` after successful sync.

State is opaque to the CLI — only the source understands the cursor format.

---

## 10. Live Mode (`--live`)

1. **Backfill phase:** Paginate all streams via Stripe List API. WebSocket events that arrive during backfill are queued.
2. **Transition:** After backfill completes, drain event queue.
3. **Live phase:** Block on WebSocket events indefinitely. Each event → `RecordMessage` + `StateMessage` → destination. Runs until SIGINT.

Without `--live`, the CLI exits after backfill. Finite process, suitable for cron.

---

## 11. Progressive Disclosure Examples

```sh
# Level 0: env vars, zero flags
export STRIPE_API_KEY=sk_test_abc
export DATABASE_URL=postgres://localhost/mydb
sync-engine

# Level 1: explicit flags
sync-engine -k sk_test_abc -d postgres://localhost/mydb

# Level 2: select streams
sync-engine -k sk_test_abc -d postgres://localhost/mydb -s customers,invoices

# Level 3: live sync, custom schema
sync-engine -k sk_test_abc -d postgres://localhost/mydb --schema stripe_live --live

# Level 4: eject config
sync-engine -k sk_test_abc -d postgres://localhost/mydb --print-config > sync.json
vim sync.json
sync-engine -c sync.json

# Level 5: inline JSON (agentic)
sync-engine -c '{"source_config":{"api_key":"sk_test_abc"},"destination_config":{"connection_string":"postgres://localhost/mydb"}}'

# Level 6: programmatic (library, not CLI)
import { createEngine } from '@stripe/stateless-sync'
```

---

## 12. Architecture

The CLI is a **thin composition root**:

```
sync-engine CLI
  ├─ resolves config (flags + env + config file → SyncParams)
  ├─ imports @stripe/source-stripe
  ├─ imports @stripe/destination-postgres
  ├─ loads state from {schema}._sync_state
  ├─ calls runSync(config, source, destination)
  ├─ persists yielded StateMessages to _sync_state
  └─ renders output to stderr/stdout
```

All sync logic stays in `sync-protocol`. All connector logic stays in source/destination packages. The CLI owns only: config resolution, state persistence bookkeeping, and output rendering.

### Package placement

Package `apps/sync-engine` (`@stripe/sync-engine`). Binary name `sync-engine` in `package.json` `bin` field.

### Key files

- `packages/protocol/src/protocol.ts` — `SyncParams`, `Source`, `Destination` interfaces
- `packages/stateless-sync/src/engine.ts` — `createEngine()`
- `packages/source-stripe/src/index.ts` — Source spec, config schema, `read()`
- `packages/destination-postgres/src/index.ts` — Destination spec, config schema, `write()`
