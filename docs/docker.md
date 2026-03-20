# With Docker

The repository `Dockerfile` builds `packages/fastify-app` and starts the Fastify service from `packages/fastify-app/dist/src/server.js`.

## Runtime Contract

The container exposes a small internal HTTP API:

- `GET /health`
- `POST /setup`
- `POST /webhook`

The service assumes webhook authenticity has already been verified upstream. Merchant-specific config is supplied in request bodies, not through long-lived environment variables.

## Build And Run

From the repo root:

```sh
pnpm install
pnpm build
docker build -t sync-engine-fastify .
docker run --rm -p 8080:8080 sync-engine-fastify
```

## Configuration

Server-level runtime configuration is controlled by:

- `PORT`
- `MAX_POSTGRES_CONNECTIONS`
- `PG_SSL_CONFIG_ENABLED`
- `PG_SSL_REJECT_UNAUTHORIZED`
- `PG_SSL_REQUEST_CERT`
- `PG_SSL_CA`
- `PG_SSL_CERT`

For request and response examples, see [packages/fastify-app/README.md](../packages/fastify-app/README.md).
