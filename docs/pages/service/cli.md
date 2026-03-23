# CLI Specification

Engine-layer CLI wrapping `runSync()` from sync-protocol.
No credentials store, no syncs CRUD, no service mode.

## `stripe-sync` — run the pipeline

The default command. Discovers streams, builds the catalog, runs
`source.read() → forward() → destination.write() → collect()`.

```sh
# Minimal — Stripe → Postgres, all streams, full_refresh
stripe-sync --api-key sk_test_... --database-url postgres://localhost/mydb

# Filter streams
stripe-sync --api-key sk_test_... --database-url postgres://... --streams customers,invoices

# Incremental with state resume
stripe-sync --api-key sk_test_... --database-url postgres://... --state state.jsonl

# Google Sheets destination (inferred from --sheets-id)
stripe-sync --api-key sk_test_... --sheets-id 1abc...xyz --streams customers

# From a JSON config file (SyncConfig shape)
stripe-sync --config sync.json

# Pipe SyncConfig via stdin
cat sync.json | stripe-sync --config -
```

**Env var alternatives:**

```sh
export STRIPE_API_KEY=sk_test_...
export DATABASE_URL=postgres://localhost/mydb
stripe-sync   # picks up from env
```

**Output contract:**

- stdout → NDJSON `StateMessage` lines (checkpoints)
- stderr → logs, errors, stream status
- Exit 0 on success, non-zero on failure

Capture state for resume:

```sh
stripe-sync ... > state.jsonl
stripe-sync ... | tee state.jsonl
```

Then resume from where you left off:

```sh
stripe-sync --api-key sk_test_... --database-url postgres://... --state state.jsonl
```

## `stripe-sync discover`

Maps to `source.discover({ config })`. Lists available streams.

```sh
# Stream names, one per line
stripe-sync discover --api-key sk_test_...

# Full CatalogMessage as JSON (with primary_key, json_schema)
stripe-sync discover --api-key sk_test_... --json
```

## `stripe-sync check`

Maps to `source.check({ config })` + `destination.check({ config })`.
Validates connectivity on both ends.

```sh
stripe-sync check --api-key sk_test_... --database-url postgres://...
# ✓ Source: connected
# ✓ Destination: connected

# Only checks source when no destination flags are present
stripe-sync check --api-key sk_test_...
# ✓ Source: connected
```

## `stripe-sync spec`

Maps to `source.spec()` / `destination.spec()`. Prints the connector's
config JSON Schema.

```sh
stripe-sync spec --source
# { "connection_specification": { ... api_key, base_url ... } }

stripe-sync spec --destination
# { "connection_specification": { ... connection_string, schema ... } }
```

## `stripe-sync migrate`

Destination-specific. Creates/updates tables before first sync.

```sh
stripe-sync migrate --database-url postgres://...
# Creates stream tables (e.g. customers, invoices) with (_pk, data) schema
```

## Destination routing

The CLI infers which destination from the flags present:

| Flags present    | Destination                      |
| ---------------- | -------------------------------- |
| `--database-url` | destination-postgres             |
| `--sheets-id`    | destination-google-sheets        |
| Both             | Error: "specify one destination" |

Pipe mode bypasses routing entirely — you pick the destination binary.

## Flag → SyncConfig mapping

| Flag             | SyncConfig field                       | Env var           |
| ---------------- | -------------------------------------- | ----------------- |
| `--api-key`      | `source_config.api_key`                | `STRIPE_API_KEY`  |
| `--base-url`     | `source_config.base_url`               | `STRIPE_BASE_URL` |
| `--database-url` | `destination_config.connection_string` | `DATABASE_URL`    |
| `--sheets-id`    | `destination_config.spreadsheet_id`    | —                 |
| `--streams`      | `streams[].name` (comma-separated)     | —                 |
| `--state`        | `state` (loaded from JSONL file)       | —                 |
| `--config`       | entire `SyncConfig` from JSON file     | —                 |

`--config` overrides all other flags. When `--config -`, reads from stdin.

## Pipe mode

Individual connector commands via `ts-cli.ts` for Unix composition.

```sh
alias source-stripe='bun packages/ts-cli/src/index.ts ./packages/source-stripe2/src/index.ts'
alias dest-postgres='bun packages/ts-cli/src/index.ts ./packages/destination-postgres2/src/index.ts'
```

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

## SyncConfig JSON shape

For `--config sync.json`:

```json
{
  "source_config": {
    "api_key": "sk_test_..."
  },
  "destination_config": {
    "connection_string": "postgres://localhost/mydb"
  },
  "streams": [{ "name": "customers", "sync_mode": "incremental" }, { "name": "invoices" }],
  "state": {
    "customers": { "pageCursor": "cus_abc123", "status": "pending" }
  }
}
```

Fields match the `SyncConfig` type in `sync-protocol/src/types.ts`:

```ts
interface SyncConfig {
  source_config: Record<string, unknown>
  destination_config: Record<string, unknown>
  streams?: Array<{ name: string; sync_mode?: 'incremental' | 'full_refresh' }>
  state?: Record<string, unknown>
}
```
