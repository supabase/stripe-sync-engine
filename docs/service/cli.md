# CLI Specification

Engine-layer CLI wrapping `createEngine()` from `@stripe/sync-engine`.
No credentials store, no syncs CRUD, no service mode.

## `sync-engine sync` — run the pipeline

Discovers streams, builds the catalog, runs
`source.read() → engine → destination.write()`.

```sh
# Minimal — Stripe → Postgres, all streams
sync-engine sync --stripe-api-key sk_test_... --postgres-url postgres://localhost/mydb

# Filter streams
sync-engine sync --stripe-api-key sk_test_... --postgres-url postgres://... --streams customers,invoices

# From a JSON config file (SyncParams shape)
sync-engine sync --config sync.json
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

## `sync-engine check`

Maps to `source.check({ config })` + `destination.check({ config })`.
Validates connectivity on both ends.

```sh
sync-engine check --stripe-api-key sk_test_... --postgres-url postgres://...
# ✓ Source: connected
# ✓ Destination: connected
```

## `sync-engine serve`

Starts the HTTP API server. The default action when invoked bare.

```sh
sync-engine serve --port 3000
# or
sync-engine --port 3000
```

## Flag → SyncParams mapping

| Flag                | SyncParams field                   | Env var                         |
| ------------------- | ---------------------------------- | ------------------------------- |
| `--stripe-api-key`  | `source.api_key`                   | `STRIPE_API_KEY`                |
| `--stripe-base-url` | `source.base_url`                  | —                               |
| `--websocket`       | `source.websocket`                 | —                               |
| `--postgres-url`    | `destination.connection_string`    | `POSTGRES_URL` / `DATABASE_URL` |
| `--postgres-schema` | `destination.schema`               | —                               |
| `--streams`         | `streams[].name` (comma-separated) | —                               |
| `--no-state`        | (skip state load/persist)          | —                               |
| `--config`          | entire `SyncParams` from JSON file | —                               |

## Pipe mode

Individual connector commands via `ts-cli` for Unix composition.

```sh
alias source-stripe='node packages/ts-cli/dist/index.js ./packages/source-stripe/dist/index.js'
alias dest-postgres='node packages/ts-cli/dist/index.js ./packages/destination-postgres/dist/index.js'
```

_(Paths are relative to the monorepo root.)_

### Source commands

```sh
# Spec
source-stripe spec

# Check credentials
source-stripe check --config '{"api_key":"sk_test_..."}'

# Discover streams
source-stripe discover --config '{"api_key":"sk_test_..."}'

# Read records (requires --config and --catalog)
source-stripe read \
  --config '{"api_key":"sk_test_..."}' \
  --catalog '{"streams":[{"stream":{"name":"customers","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'
```

### Destination commands

```sh
# Spec
dest-postgres spec

# Check connectivity
dest-postgres check --config '{"connection_string":"postgres://localhost/mydb"}'

# Write (reads NDJSON from stdin)
source-stripe read --config '...' --catalog '...' \
  | dest-postgres write --config '{"connection_string":"postgres://localhost/mydb"}' --catalog '...'
```

### Filtering with jq

```sh
# Extract just record IDs
source-stripe read --config '...' --catalog '...' \
  | jq -r 'select(.type == "record") | .data.id'

# Filter to one stream in a multi-stream read
source-stripe read --config '...' --catalog '...' \
  | jq -c 'select(.stream == "customers")'

# Compact summary per message
source-stripe read --config '...' --catalog '...' \
  | jq -c '{type, stream, id: .data.id}'
```

## SyncParams JSON shape

For `--config sync.json`:

```json
{
  "source": {
    "name": "stripe",
    "api_key": "sk_test_..."
  },
  "destination": {
    "name": "postgres",
    "connection_string": "postgres://localhost/mydb"
  },
  "streams": [{ "name": "customers", "sync_mode": "incremental" }, { "name": "invoices" }]
}
```

Fields match the `SyncParams` type in `@stripe/sync-engine`:

```ts
interface SyncParams {
  source: { name: string } & Record<string, unknown>
  destination: { name: string } & Record<string, unknown>
  streams?: Array<{ name: string; sync_mode?: 'incremental' | 'full_refresh' }>
  state?: Record<string, unknown>
}
```
