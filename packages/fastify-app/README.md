# Stripe Sync Engine - Fastify App

![GitHub License](https://img.shields.io/github/license/supabase/stripe-sync-engine)
![Docker Image Version](https://img.shields.io/docker/v/supabase/stripe-sync-engine?label=Docker)

A Fastify-based webhook ingress service for syncing multiple Stripe merchants to PostgreSQL in real time. Built on top of the Stripe Sync Engine.

## Features

- Exposes a single `POST /webhooks` endpoint for public Stripe webhook ingress
- Routes each request to the correct merchant via the request `Host` header
- Supports multiple merchants from one deployment via `MERCHANT_CONFIG_JSON`
- Keeps public surface area small (`/webhooks` + `/health`)
- Runs as a lightweight Docker container

## Quick Start

### 1. Pull the image

```sh
docker pull supabase/stripe-sync-engine:latest
```

### 2. Run the container

```sh
docker run -d \
  -e MERCHANT_CONFIG_JSON='{"acct-a.sync.stripedb.com":{"databaseUrl":"postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable&search_path=stripe","stripeSecretKey":"sk_test_a","stripeWebhookSecret":"whsec_a"},"acct-b.sync.stripedb.com":{"databaseUrl":"postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable&search_path=stripe","stripeSecretKey":"sk_test_b","stripeWebhookSecret":"whsec_b"}}' \
  -p 8080:8080 \
  supabase/stripe-sync-engine:latest
```

### 3. Configuration

Configure one Stripe webhook endpoint per merchant host (for example, `https://acct-a.sync.stripedb.com/webhooks`) and include every host in `MERCHANT_CONFIG_JSON`.

## Environment Variables

| Variable                            | Description                                                                                                                                                                                                                                                                                              | Required |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `MERCHANT_CONFIG_JSON`              | JSON object keyed by host: `{ "<host>": { "databaseUrl", "stripeSecretKey", "stripeWebhookSecret", "enableSigma?", "autoExpandLists?", "backfillRelatedEntities?" } }`                                                                                                                                   | Yes      |
| `PORT`                              | Port to run the server on (default: 8080)                                                                                                                                                                                                                                                                | No       |
| `STRIPE_API_VERSION`                | Stripe API version (default: `2020-08-27`)                                                                                                                                                                                                                                                               | No       |
| `ENABLE_SIGMA`                      | Default value for merchant entries that omit `enableSigma` (default: false)                                                                                                                                                                                                                              | No       |
| `AUTO_EXPAND_LISTS`                 | Default value for merchant entries that omit `autoExpandLists` (default: false)                                                                                                                                                                                                                          | No       |
| `BACKFILL_RELATED_ENTITIES`         | Default value for merchant entries that omit `backfillRelatedEntities` (default: true)                                                                                                                                                                                                                   | No       |
| `MAX_POSTGRES_CONNECTIONS`          | Max PostgreSQL connection pool size per merchant `StripeSync` instance (default: 10)                                                                                                                                                                                                                     | No       |
| `REVALIDATE_OBJECTS_VIA_STRIPE_API` | Always fetch latest entity from Stripe instead of trusting webhook payload, possible values: charge, credit_note, customer, dispute, invoice, payment_intent, payment_method, plan, price, product, refund, review, radar.early_fraud_warning, setup_intent, subscription, subscription_schedule, tax_id | No       |
| `DISABLE_MIGRATIONS`                | Disable automated database migrations on app startup (default: false)                                                                                                                                                                                                                                    | No       |
| `PG_SSL_CONFIG_ENABLED`             | Whether to explicitly use the SSL configuration (default: false)                                                                                                                                                                                                                                         | No       |
| `PG_SSL_REJECT_UNAUTHORIZED`        | If true the server will reject any connection not authorized with supplied CAs (effective when `requestCert` is true)                                                                                                                                                                                    | No       |
| `PG_SSL_REQUEST_CERT`               | If true the server will request a client certificate and verify it (default: false)                                                                                                                                                                                                                      | No       |
| `PG_SSL_CA`                         | Optionally override trusted CA certificates                                                                                                                                                                                                                                                              | No       |
| `PG_SSL_CERT`                       | Certificate chain in PEM format                                                                                                                                                                                                                                                                          | No       |

## Endpoints

- `POST /webhooks` — Receives Stripe webhook events and syncs data to PostgreSQL
- `GET /health` — Health check endpoint

## Example Docker Compose

```yaml
version: '3'
services:
  postgres:
    image: postgres:17
    restart: always
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: postgres
    ports:
      - 5432:5432
    volumes:
      - pgdata:/var/lib/postgresql/data

  stripe-sync:
    image: supabase/stripe-sync-fastify:latest
    depends_on:
      - postgres
    ports:
      - 8080:8080
    environment:
      MERCHANT_CONFIG_JSON: >
        {"acct-a.sync.stripedb.com":{"databaseUrl":"postgres://postgres:postgres@postgres:5432/postgres?sslmode=disable&search_path=stripe","stripeSecretKey":"sk_test_a","stripeWebhookSecret":"whsec_a"}}

volumes:
  pgdata:
```

Backfill/admin operations should run through internal one-off tasks, not public HTTP routes.
