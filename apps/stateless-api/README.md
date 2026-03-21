# sync-engine-api (stateless HTTP API)

Stateless HTTP API wrapping the sync engine. Each request is self-contained — no persistent
storage. Suitable for serverless deployment or as a sidecar alongside your application.

## Start

```sh
PORT=3001 sync-engine-api
# or
PORT=3001 node dist/index.js
```

Default port: `3001`.

## Authentication

None — deploy behind a reverse proxy or auth gateway for production use.

## X-Sync-Params header

Every endpoint requires an `X-Sync-Params` header containing a JSON-encoded `SyncParams`
object. Same schema as the CLI `--params` flag:

```json
{
  "source_name": "stripe",
  "destination_name": "postgres",
  "source_config": { "api_key": "sk_test_..." },
  "destination_config": { "connection_string": "postgresql://user:pass@localhost/mydb" },
  "streams": [
    { "name": "customers", "sync_mode": "incremental" }
  ],
  "state": {}
}
```

See the [stateless-cli README](../stateless-cli/README.md#syncparams) for full field
descriptions.

## Endpoints

### `POST /setup`

Provision external resources (destination tables, webhook endpoints, etc.).

```sh
curl -X POST http://localhost:3001/setup \
  -H 'X-Sync-Params: {"destination_name":"postgres","source_config":{"api_key":"sk_..."},"destination_config":{"connection_string":"postgresql://..."}}'
```

Returns `204 No Content` on success.

### `POST /teardown`

Clean up external resources provisioned by `setup`.

Returns `204 No Content` on success.

### `GET /check`

Validate connectivity to both source and destination.

```sh
curl http://localhost:3001/check -H 'X-Sync-Params: ...'
```

Response:

```json
{ "source": { "status": "succeeded" }, "destination": { "status": "succeeded" } }
```

### `POST /read`

Read records from the source. Returns an SSE stream of `Message` objects.

Optionally accepts an NDJSON request body to pass as input to the source
(e.g. to replay webhook events or inject live data).

```sh
curl -X POST http://localhost:3001/read \
  -H 'X-Sync-Params: ...' \
  --no-buffer
```

### `POST /write`

Write messages to the destination. Request body must be NDJSON-encoded `Message` objects.
Returns an SSE stream of `StateMessage` objects.

```sh
curl -X POST http://localhost:3001/write \
  -H 'X-Sync-Params: ...' \
  -H 'Content-Type: application/x-ndjson' \
  --data-binary @messages.ndjson \
  --no-buffer
```

### `POST /run`

Full pipeline: read from source then write to destination.
Optionally accepts NDJSON input in the request body (passed to the source).
Returns an SSE stream of `StateMessage` objects.

```sh
curl -X POST http://localhost:3001/run \
  -H 'X-Sync-Params: ...' \
  --no-buffer
```

## SSE response format

Streaming endpoints (`/read`, `/write`, `/run`) respond with `Content-Type: text/event-stream`.
Each event is a JSON-encoded message on the `data:` field:

```
data: {"type":"record","stream":"customers","data":{...}}

data: {"type":"state","stream":"customers","data":{...}}

event: error
data: {"error":"connection refused"}
```

Parse with any SSE client library, or consume with `curl --no-buffer` and split on blank lines.

## Using as a library

`createApp` is exported for embedding in a larger Hono application:

```ts
import { createApp, createConnectorResolver } from '@stripe/sync-engine-stateless-api'

const resolver = createConnectorResolver({
  sources:      { stripe:   myStripeConnector },
  destinations: { postgres: myPostgresConnector },
})

const app = createApp(resolver)
// app.fetch is a standard Request → Response handler
// Works with Cloudflare Workers, Bun, Node via @hono/node-server, etc.
```
