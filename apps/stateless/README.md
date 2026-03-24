# sync-engine-stateless

Stateless CLI and HTTP API for running one-shot syncs. Every invocation is  
self-contained — the caller supplies all config; nothing is stored between runs.

## Install

```sh
pnpm add @tx-stripe/sync-engine-stateless
```

Or run directly after building the monorepo:

```sh
pnpm build
node apps/stateless/dist/cli/index.js --help
```

---

## CLI — `sync-engine-stateless`

### Config resolution

All commands accept the same set of options. Config is resolved in priority order:

| Priority    | Source                                           |
| ----------- | ------------------------------------------------ |
| 1 (highest) | `--source-config` / `--destination-config` flags |
| 2           | `SOURCE_*` / `DESTINATION_*` env vars            |
| 3           | `--config` file                                  |
| 4 (lowest)  | `--params` blob                                  |

### Shared options

```
--source <type>                Source connector (default: "stripe")
--destination <type>           Destination connector
--source-config <value>        Source config — inline JSON or file path
--destination-config <value>   Destination config — inline JSON or file path
--streams <names>              Comma-separated stream names to sync
--config <value>               Full config object — inline JSON or file path
--params <value>               Full SyncParams blob — inline JSON or file path
```

`--source-config` and `--destination-config` accept either inline JSON
(`'{"api_key":"..."}'`) or a path to a JSON file (`./stripe-creds.json`).

### Commands

#### `setup`

Provision external resources (webhook endpoints, destination tables, etc.).

```sh
sync-engine-stateless setup \
  --source stripe \
  --destination postgres \
  --source-config '{"api_key":"sk_test_..."}' \
  --destination-config '{"connection_string":"postgresql://..."}'
```

#### `teardown`

Clean up external resources created by `setup`.

```sh
sync-engine-stateless teardown --config sync.json
```

#### `check`

Validate that the source and destination are reachable. Outputs a JSON object
to stdout.

```sh
sync-engine-stateless check --config sync.json
# → {"source":{"status":"ok"},"destination":{"status":"ok"}}
```

#### `read`

Read records from the source. Streams NDJSON `Message` objects to stdout.

```sh
sync-engine-stateless read --config sync.json > messages.ndjson
```

Accepts optional NDJSON input on stdin (e.g. a prior state message to resume
from a cursor).

#### `write`

Write records to the destination. Reads NDJSON `Message` objects from stdin,
streams NDJSON `StateMessage` objects to stdout.

```sh
cat messages.ndjson | sync-engine-stateless write --config sync.json
```

#### `run`

Full pipeline: `setup → read → write`. Streams `StateMessage` objects to stdout.

```sh
sync-engine-stateless run --config sync.json
```

### Config file format (`--config`)

```json
{
  "source_name": "stripe",
  "destination_name": "postgres",
  "source_config": {
    "api_key": "sk_test_..."
  },
  "destination_config": {
    "connection_string": "postgresql://user:pass@localhost/mydb"
  },
  "streams": [{ "name": "customers" }, { "name": "subscriptions" }]
}
```

### Env var overrides

Any field in `source_config` or `destination_config` can be set via env vars
using the `SOURCE_` or `DESTINATION_` prefix:

```sh
SOURCE_API_KEY=sk_test_... \
DESTINATION_CONNECTION_STRING=postgresql://... \
  sync-engine-stateless run --source stripe --destination postgres
```

Env var names are uppercased and prefixed; field names are lowercased with
underscores. `SOURCE_API_KEY` → `source_config.api_key`.

### Unix pipe composition

`read` and `write` can be composed as separate processes:

```sh
sync-engine-stateless read --config sync.json \
  | sync-engine-stateless write --config sync.json
```

---

## HTTP API — `sync-engine-stateless-api`

A stateless HTTP wrapper around the same engine. All config is passed
per-request via the `X-Sync-Params` header — no server-side state.

Default port: **3001** (override with `PORT` env var).

```sh
sync-engine-stateless-api
# Sync Engine API listening on http://localhost:3001
```

### Endpoints

All endpoints require the `X-Sync-Params` header containing a JSON-encoded
`SyncParams` object:

```
X-Sync-Params: {"source_name":"stripe","destination_name":"postgres","source_config":{...},"destination_config":{...}}
```

| Method | Path        | Description                  | Response                                   |
| ------ | ----------- | ---------------------------- | ------------------------------------------ |
| `POST` | `/setup`    | Provision external resources | `204 No Content`                           |
| `POST` | `/teardown` | Clean up external resources  | `204 No Content`                           |
| `GET`  | `/check`    | Check connectivity           | `200 {"source":{...},"destination":{...}}` |
| `POST` | `/read`     | Stream records from source   | `200 NDJSON stream`                        |
| `POST` | `/write`    | Write records to destination | `200 NDJSON stream`                        |
| `POST` | `/run`      | Full pipeline                | `200 NDJSON stream`                        |

`/read` and `/run` accept an optional NDJSON request body (input messages).
`/write` requires a NDJSON request body (messages to write).

Streaming endpoints respond with `Content-Type: application/x-ndjson`.

### Example

```sh
curl -s http://localhost:3001/run \
  -H 'Content-Type: application/json' \
  -H 'X-Sync-Params: {"source_name":"stripe","destination_name":"postgres","source_config":{"api_key":"sk_test_..."},"destination_config":{"connection_string":"postgresql://..."}}'
```

---

## FAQ

### Why do `read` and `write` both require full source + destination config?

The configured catalog — which streams to sync, their sync modes, and their
schemas — is a property of the source/destination pair, not either side alone.
`read` calls `source.discover()` to build the catalog, and `write` passes that
same catalog to `destination.write()` so the destination can provision the right
tables/columns. Both sides need to agree on the catalog for a sync to work.

### I only care about testing my destination (or source). Do I have to configure both?

Use the test connectors from `@tx-stripe/stateless-sync`. They're in-process
utilities intended for this exact case:

- **`testSource`** — declares stream names from config and passes `$stdin`
  through as records; always returns `{ status: 'succeeded' }` on `check`
- **`testDestination`** — discards all records, passes state messages through;
  empty config `{}`

Pass them directly when constructing the engine in code:

```ts
import { createEngine, testSource, testDestination } from '@tx-stripe/stateless-sync'

// Test your destination with a trivial source
const engine = createEngine(params, {
  source: testSource,
  destination: myDestination,
})

// Test your source with a no-op destination
const engine = createEngine(params, {
  source: mySource,
  destination: testDestination,
})
```
