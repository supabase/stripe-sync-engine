# sync-engine-stateful-api (stateful HTTP API)

Stateful HTTP API for managing credentials and syncs. Persists credentials, sync configs,
state, and logs to the local filesystem. Exposes a REST management plane for CRUD operations
plus an SSE endpoint to trigger runs.

## Start

```sh
PORT=3002 sync-engine-stateful-api
# or
PORT=3002 node dist/index.js
```

Default port: `3002`.

Data is stored under `.sync-service/` in the working directory (override with `DATA_DIR`):

```
.sync-service/
  credentials.json
  syncs.json
  state.json
  logs.ndjson
```

## Interactive docs

Swagger UI is available at `http://localhost:3002/docs`.
OpenAPI spec is at `http://localhost:3002/openapi.json`.

## Authentication

None — deploy behind a reverse proxy or auth gateway for production use.

## Credentials

Credentials store connector secrets (API keys, database passwords). They are referenced by
syncs via `credential_id`.

### `GET /credentials`

List all credentials.

```sh
curl http://localhost:3002/credentials
# { "data": [...], "has_more": false }
```

### `POST /credentials`

Create a credential. The `type` field determines the shape.

**Stripe:**
```sh
curl -X POST http://localhost:3002/credentials \
  -H 'Content-Type: application/json' \
  -d '{ "type": "stripe", "api_key": "sk_test_..." }'
# { "id": "cred_abc123", "account_id": "acct_default", "type": "stripe", "api_key": "sk_test_..." }
```

**Postgres:**
```sh
curl -X POST http://localhost:3002/credentials \
  -H 'Content-Type: application/json' \
  -d '{ "type": "postgres", "host": "localhost", "port": 5432, "user": "me", "password": "secret", "database": "mydb" }'
```

**Google (OAuth):**
```sh
curl -X POST http://localhost:3002/credentials \
  -H 'Content-Type: application/json' \
  -d '{ "type": "google", "client_id": "...", "client_secret": "...", "refresh_token": "..." }'
```

### `GET /credentials/:id`

Retrieve a single credential.

### `PATCH /credentials/:id`

Update credential fields. Only the supplied fields are changed.

```sh
curl -X PATCH http://localhost:3002/credentials/cred_abc123 \
  -H 'Content-Type: application/json' \
  -d '{ "api_key": "sk_test_new..." }'
```

### `DELETE /credentials/:id`

Delete a credential.

```sh
curl -X DELETE http://localhost:3002/credentials/cred_abc123
# { "id": "cred_abc123", "deleted": true }
```

## Syncs

A sync links a source credential + config to a destination credential + config.

### `GET /syncs`

List all syncs.

### `POST /syncs`

Create a sync.

```sh
curl -X POST http://localhost:3002/syncs \
  -H 'Content-Type: application/json' \
  -d '{
    "account_id": "acct_default",
    "status": "backfilling",
    "source": {
      "type": "stripe-api-core",
      "livemode": false,
      "api_version": "2025-04-30.basil",
      "credential_id": "cred_stripe123"
    },
    "destination": {
      "type": "postgres",
      "schema_name": "stripe_sync",
      "credential_id": "cred_pg456"
    },
    "streams": [
      { "name": "customers", "sync_mode": "incremental" },
      { "name": "charges",   "sync_mode": "full_refresh" }
    ]
  }'
# { "id": "sync_abc123", ... }
```

### `GET /syncs/:id`

Retrieve a single sync.

### `PATCH /syncs/:id`

Update sync fields. Only the supplied fields are changed.

```sh
curl -X PATCH http://localhost:3002/syncs/sync_abc123 \
  -H 'Content-Type: application/json' \
  -d '{ "status": "paused" }'
```

### `DELETE /syncs/:id`

Delete a sync.

### `POST /syncs/:id/run`

Trigger a sync run. Returns an SSE stream of events.

```sh
curl -X POST http://localhost:3002/syncs/sync_abc123/run --no-buffer
```

SSE events:

| Event | Data | Description |
|---|---|---|
| *(default)* | `StateMessage` JSON | Emitted after each batch is written to the destination |
| `done` | `{ "status": "completed" }` | Emitted when the sync finishes cleanly |
| `error` | `{ "error": "..." }` | Emitted if the run throws |

Example output:

```
id: 0
event: state
data: {"type":"state","stream":"customers","data":{"cursor":"cus_xyz"}}

id: 1
event: done
data: {"status":"completed"}
```

## Full workflow example

```sh
# 1. Store credentials
STRIPE_CRED=$(curl -s -X POST http://localhost:3002/credentials \
  -H 'Content-Type: application/json' \
  -d '{"type":"stripe","api_key":"sk_test_..."}' | jq -r .id)

PG_CRED=$(curl -s -X POST http://localhost:3002/credentials \
  -H 'Content-Type: application/json' \
  -d '{"type":"postgres","host":"localhost","port":5432,"user":"me","password":"secret","database":"mydb"}' | jq -r .id)

# 2. Create a sync
SYNC_ID=$(curl -s -X POST http://localhost:3002/syncs \
  -H 'Content-Type: application/json' \
  -d "{
    \"account_id\": \"acct_default\",
    \"status\": \"backfilling\",
    \"source\": { \"type\": \"stripe-api-core\", \"livemode\": false, \"api_version\": \"2025-04-30.basil\", \"credential_id\": \"$STRIPE_CRED\" },
    \"destination\": { \"type\": \"postgres\", \"schema_name\": \"stripe_sync\", \"credential_id\": \"$PG_CRED\" }
  }" | jq -r .id)

# 3. Run it
curl -X POST "http://localhost:3002/syncs/$SYNC_ID/run" --no-buffer
```
