# Stripe Sync Engine - Fastify App

Simple internal Fastify service and Docker image for running the sync engine as a long-running process.

## API Contract

This service exposes three routes:

- `GET /health`
- `POST /setup`
- `POST /webhook`

The HTTP layer is intentionally thin:

- Merchant-specific config is provided in each request body.
- There is no host-based tenant routing.
- There is no webhook signature verification in this service.
- Errors are returned as `{ "error": "..." }`.

## Request Bodies

`POST /setup`

```json
{
  "merchantId": "acct_123",
  "merchantConfig": {
    "databaseUrl": "postgresql://postgres:postgres@localhost:5432/postgres",
    "stripeSecretKey": "sk_test_123",
    "schemaName": "stripe_acct_123"
  }
}
```

Runs migrations for the supplied merchant database/schema and returns:

```json
{
  "ok": true,
  "merchantId": "acct_123",
  "schemaName": "stripe_acct_123"
}
```

`POST /webhook`

```json
{
  "merchantId": "acct_123",
  "merchantConfig": {
    "databaseUrl": "postgresql://postgres:postgres@localhost:5432/postgres",
    "stripeSecretKey": "sk_test_123",
    "schemaName": "stripe_acct_123"
  },
  "event": {
    "id": "evt_123",
    "object": "event",
    "type": "invoice.updated",
    "data": {
      "object": {
        "id": "in_123",
        "object": "invoice"
      }
    }
  }
}
```

Processes a pre-validated Stripe event and returns:

```json
{
  "ok": true,
  "merchantId": "acct_123",
  "eventId": "evt_123",
  "eventType": "invoice.updated"
}
```

`GET /health`

```json
{
  "ok": true
}
```

## Environment Variables

Only server-level runtime settings come from environment variables:

| Variable                     | Description                                                | Required |
| ---------------------------- | ---------------------------------------------------------- | -------- |
| `PORT`                       | Port to listen on. Defaults to `8080`.                     | No       |
| `MAX_POSTGRES_CONNECTIONS`   | Connection pool size per request. Defaults to `10`.        | No       |
| `PG_SSL_CONFIG_ENABLED`      | Enables explicit Postgres SSL config. Defaults to `false`. | No       |
| `PG_SSL_REJECT_UNAUTHORIZED` | Reject unauthorized SSL connections. Defaults to `false`.  | No       |
| `PG_SSL_REQUEST_CERT`        | Request a client certificate. Defaults to `false`.         | No       |
| `PG_SSL_CA`                  | Optional PEM CA bundle.                                    | No       |
| `PG_SSL_CERT`                | Optional PEM client certificate chain.                     | No       |

Merchant credentials and schema information are not loaded from environment variables. Send them in the `/setup` and `/webhook` request body.

## Local Usage

Build the monorepo first:

```sh
pnpm install
pnpm build
```

Build and run the Docker image from the repo root:

```sh
docker build -t sync-engine-fastify .
docker run --rm -p 8080:8080 sync-engine-fastify
```

Example health check:

```sh
curl http://localhost:8080/health
```
