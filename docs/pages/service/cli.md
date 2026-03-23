# CLI Specification

Engine-layer CLI wrapping `createEngine()` from `@stripe/stateless-sync`.
No credentials store, no syncs CRUD, no service mode.

## `sync-engine` — run the pipeline

The default command. Discovers streams, builds the catalog, runs
`source.read() → engine → destination.write()`.

```sh
# Minimal — Stripe → Postgres, all streams, full_refresh
sync-engine --api-key sk_test_... --database-url postgres://localhost/mydb

# Filter streams
sync-engine --api-key sk_test_... --database-url postgres://... --streams customers,invoices

# Google Sheets destination (inferred from --sheets-id)
sync-engine --api-key sk_test_... --sheets-id 1abc...xyz --streams customers

# From a JSON config file (SyncParams shape)
sync-engine --config sync.json

# Pipe SyncParams via stdin
cat sync.json | sync-engine --config -
```

**Env var alternatives:**

```sh
export STRIPE_API_KEY=sk_test_...
export DATABASE_URL=postgres://localhost/mydb
sync-engine   # picks up from env
```

**Output contract:**

- stdout → NDJSON `StateMessage` lines (checkpoints)
- stderr → logs, errors, stream status
- Exit 0 on success, non-zero on failure

## `sync-engine discover`

Maps to `source.discover({ config })`. Lists available streams.

```sh
# Stream names, one per line
sync-engine discover --api-key sk_test_...

# Full CatalogMessage as JSON (with primary_key, json_schema)
sync-engine discover --api-key sk_test_... --json
```

## `sync-engine check`

Maps to `source.check({ config })` + `destination.check({ config })`.
Validates connectivity on both ends.

```sh
sync-engine check --api-key sk_test_... --database-url postgres://...
# ✓ Source: connected
# ✓ Destination: connected

# Only checks source when no destination flags are present
sync-engine check --api-key sk_test_...
# ✓ Source: connected
```

## `sync-engine spec`

Maps to `source.spec()` / `destination.spec()`. Prints the connector's
config JSON Schema.

```sh
sync-engine spec --source
# { "connection_specification": { ... api_key, base_url ... } }

sync-engine spec --destination
# { "connection_specification": { ... connection_string, schema ... } }
```

## `sync-engine migrate`

Destination-specific. Creates/updates tables before first sync.

```sh
sync-engine migrate --database-url postgres://...
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

## Flag → SyncParams mapping

| Flag             | SyncParams field                       | Env var           |
| ---------------- | -------------------------------------- | ----------------- |
| `--api-key`      | `source_config.api_key`                | `STRIPE_API_KEY`  |
| `--base-url`     | `source_config.base_url`               | `STRIPE_BASE_URL` |
| `--database-url` | `destination_config.connection_string` | `DATABASE_URL`    |
| `--sheets-id`    | `destination_config.spreadsheet_id`    | —                 |
| `--streams`      | `streams[].name` (comma-separated)     | —                 |
| `--config`       | entire `SyncParams` from JSON file     | —                 |

`--config` overrides all other flags. When `--config -`, reads from stdin.

## Pipe mode

Individual connector commands via `ts-cli` for Unix composition.

```sh
alias source-stripe='node packages/ts-cli/dist/index.js ./packages/source-stripe/dist/index.js'
alias dest-postgres='node packages/ts-cli/dist/index.js ./packages/destination-postgres/dist/index.js'
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

## SyncParams JSON shape

For `--config sync.json`:

```json
{
  "source_config": {
    "api_key": "sk_test_..."
  },
  "destination_config": {
    "connection_string": "postgres://localhost/mydb"
  },
  "streams": [{ "name": "customers", "sync_mode": "incremental" }, { "name": "invoices" }]
}
```

Fields match the `SyncParams` type in `@stripe/stateless-sync`:

```ts
interface SyncParams {
  source_config: Record<string, unknown>
  destination_config: Record<string, unknown>
  streams?: Array<{ name: string; sync_mode?: 'incremental' | 'full_refresh' }>
  state?: Record<string, unknown>
}
```
