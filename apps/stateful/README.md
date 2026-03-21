# sync-engine-stateful

Stateful CLI and HTTP API for managing credentials, syncs, and persistent state.
Credentials and sync configs are stored in JSON files under a data directory;
state (stream cursors) is checkpointed automatically so syncs resume where they
left off.

## Data directory

All state lives under `~/.stripe-sync` by default. Override with `--data-dir`
(CLI) or `DATA_DIR` env var (both CLI and API).

```
~/.stripe-sync/
  credentials.json   # stored connector credentials
  syncs.json         # sync configurations
  state.json         # stream cursors (checkpointed after each write)
  logs.ndjson        # run history
```

---

## CLI — `sync-engine-stateful`

Reads `.env` from the current directory automatically.

### Shared options

```
--sync-id <id>      Sync ID to operate on (default: "cli_sync")
--data-dir <path>   Data directory (default: ~/.stripe-sync)
```

### Commands

#### `setup`

Provision external resources for the configured sync (e.g. create destination
tables, register webhook endpoints).

```sh
sync-engine-stateful setup --sync-id my_sync
```

#### `teardown`

Clean up external resources.

```sh
sync-engine-stateful teardown --sync-id my_sync
```

#### `check`

Validate source and destination connectivity. Outputs a JSON result to stdout.

```sh
sync-engine-stateful check --sync-id my_sync
# → {"source":{"status":"ok"},"destination":{"status":"ok"}}
```

#### `read`

Read records from the source. Streams NDJSON `Message` objects to stdout.

```sh
sync-engine-stateful read --sync-id my_sync > messages.ndjson
```

#### `write`

Write records to the destination. Reads NDJSON from stdin, streams
`StateMessage` checkpoints to stdout.

```sh
cat messages.ndjson | sync-engine-stateful write --sync-id my_sync
```

#### `run`

Full pipeline: setup → read → write, with automatic state checkpointing.
Streams `StateMessage` objects to stdout.

```sh
sync-engine-stateful run --sync-id my_sync
```

### Env var overrides

`SOURCE_*` and `DESTINATION_*` env vars overlay on top of stored credential
fields at runtime. Useful for overriding a stored credential without editing it:

```sh
SOURCE_API_KEY=sk_test_override sync-engine-stateful run --sync-id my_sync
```

`SOURCE_API_KEY` → overrides `api_key` in the source config (after credential
lookup). The cascade is: **CLI flags > env vars > stored credential**.

---

## HTTP API — `sync-engine-stateful-api`

A REST API for managing credentials and syncs, plus streaming endpoints for
running them. Backed by the same file stores as the CLI.

Default port: **3002** (override with `PORT` env var).

```sh
sync-engine-stateful-api [--data-dir <path>]
# Stripe Sync Stateful API listening on http://localhost:3002
```

OpenAPI spec: `GET /openapi.json`
Swagger UI: `GET /docs`

### Credentials

| Method   | Path                | Description           |
| -------- | ------------------- | --------------------- |
| `GET`    | `/credentials`      | List all credentials  |
| `POST`   | `/credentials`      | Create a credential   |
| `GET`    | `/credentials/{id}` | Retrieve a credential |
| `PATCH`  | `/credentials/{id}` | Update a credential   |
| `DELETE` | `/credentials/{id}` | Delete a credential   |

#### Create a Stripe credential

```sh
curl -s http://localhost:3002/credentials \
  -H 'Content-Type: application/json' \
  -d '{"type":"stripe","api_key":"sk_test_..."}'
# → {"id":"cred_abc123","type":"stripe","api_key":"sk_test_...","created_at":"..."}
```

### Syncs

| Method   | Path          | Description     |
| -------- | ------------- | --------------- |
| `GET`    | `/syncs`      | List all syncs  |
| `POST`   | `/syncs`      | Create a sync   |
| `GET`    | `/syncs/{id}` | Retrieve a sync |
| `PATCH`  | `/syncs/{id}` | Update a sync   |
| `DELETE` | `/syncs/{id}` | Delete a sync   |

#### Create a sync

```sh
curl -s http://localhost:3002/syncs \
  -H 'Content-Type: application/json' \
  -d '{
    "source": { "type": "stripe", "credential_id": "cred_abc123" },
    "destination": { "type": "postgres", "credential_id": "cred_def456" },
    "streams": [{ "name": "customers" }, { "name": "subscriptions" }]
  }'
# → {"id":"sync_abc123","source":{...},"destination":{...},"streams":[...]}
```

### Sync operations

These endpoints operate on a stored sync by ID. Streaming endpoints respond
with `Content-Type: application/x-ndjson`.

| Method | Path                   | Description                  | Response         |
| ------ | ---------------------- | ---------------------------- | ---------------- |
| `POST` | `/syncs/{id}/setup`    | Provision resources          | `204 No Content` |
| `POST` | `/syncs/{id}/teardown` | Clean up resources           | `204 No Content` |
| `GET`  | `/syncs/{id}/check`    | Check connectivity           | `200 JSON`       |
| `POST` | `/syncs/{id}/read`     | Stream records from source   | `200 NDJSON`     |
| `POST` | `/syncs/{id}/write`    | Write records to destination | `200 NDJSON`     |
| `POST` | `/syncs/{id}/run`      | Full pipeline                | `200 NDJSON`     |

#### Run a sync

```sh
curl -s -N http://localhost:3002/syncs/sync_abc123/run
# streams StateMessage objects as NDJSON
```

`/read` and `/run` accept an optional NDJSON request body (input messages).
`/write` requires a NDJSON request body.
