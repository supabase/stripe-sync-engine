# With Docker

![GitHub License](https://img.shields.io/github/license/supabase/stripe-sync-engine)
![Docker Image Version](https://img.shields.io/docker/v/supabase/stripe-sync-engine?label=Docker)

A Fastify-based server for syncing your Stripe account to a PostgreSQL database in real time. Built on top of the Stripe Sync Engine.

## Features

- Exposes a `/webhooks` endpoint to receive Stripe webhooks and sync data to PostgreSQL
- Supports syncing customers, invoices, products, subscriptions, and more
- Runs as a lightweight Docker container
- Designed for easy deployment to any cloud or self-hosted environment

## Quick Start

### 1. Pull the image

```sh
docker pull supabase/stripe-sync-engine:latest
```

### 2. Run the container

```sh
docker run -d \
  -e DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  -e STRIPE_SECRET_KEY=sk_test_... \
  -e STRIPE_WEBHOOK_SECRET=... \
  -e API_KEY="my-secret" \
  -p 8080:8080 \
  supabase/stripe-sync-engine:latest
```

### 3. Configuration

Set your webhook endpoint in the Stripe dashboard to point to your server’s `/webhooks` route (e.g., `https://yourdomain.com/webhooks`).

## Environment Variables

| Variable | Description | Required |
| -------- | ----------- | -------- |
| `DATABASE_URL` | PostgreSQL connection string (with `search_path=stripe`) | Yes |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | Yes |
| `API_KEY` | API key for admin endpoints (backfilling, etc.) | Yes |
| `SCHEMA` | Database schema name (default: `stripe`) | No |
| `STRIPE_SECRET_KEY` | Stripe secret key (needed for active sync/backfill) | No |
| `PORT` | Port to run the server on (default: 8080) | No |
| `STRIPE_API_VERSION` | Stripe API version (default: `2020-08-27`) | No |
| `AUTO_EXPAND_LISTS` | Fetch all list items from Stripe (default: false) | No |
| `BACKFILL_RELATED_ENTITIES` | Backfill related entities for foreign key integrity (default: true) | No |
| `MAX_POSTGRES_CONNECTIONS` | Max PostgreSQL connection pool size (default: 10) | No |
| `REVALIDATE_OBJECTS_VIA_STRIPE_API` | Always fetch latest entity from Stripe (default: false) | No |
| `DISABLE_MIGRATIONS` | Disable the automated database migrations on app startup (default: false) | No |
| `PG_SSL_CONFIG_ENABLED` | Enables SSL configuration. Set to `true` to enable | No |
| `PG_SSL_REJECT_UNAUTHORIZED` | Rejects unauthorized SSL connections. Set to `true` to enforce | No |
| `PG_SSL_CA` | Base64-encoded CA certificate for SSL connections | No |
| `PG_SSL_CERT` | Certificate chain in PEM format for SSL connections | No |
| `PG_SSL_REQUEST_CERT` | Requests a certificate from clients and attempts to verify it. Set to `true` to enable | No |

## Endpoints

- `POST /webhooks` — Receives Stripe webhook events and syncs data to PostgreSQL
- `GET /health` — Health check endpoint
- `POST /sync` — Backfill Stripe data to PostgreSQL (API key required)
- `POST /sync/single/:stripeId` — Backfill or update a single Stripe entity by ID (API key required)
- `POST /daily` — Backfill data from the last 24 hours (API key required)
- `POST /weekly` — Backfill data from the last 7 days (API key required)
- `POST /monthly` — Backfill data from the last 30 days (API key required)

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
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/postgres?sslmode=disable&search_path=stripe
      STRIPE_SECRET_KEY: sk_test_...
      STRIPE_WEBHOOK_SECRET: whsec_...
      API_KEY: my-secret

volumes:
  pgdata:
```

## Backfill from Stripe

> **Note:**
> The `/sync` endpoints are **NOT** recommended for use if you have more than 10,000 objects in Stripe. For large backfills, it is best to write a script that loops through each day and sets the `created` date filters to the start and end of day.

```
POST /sync
body: {
  "object": "product",
  "created": {
    "gte": 1643872333
  }
}
```

- `object` **all** | **charge** | **customer** | **dispute** | **invoice** | **payment_method** | **payment_intent** | **plan** | **price** | **product** | **setup_intent** | **subscription** | **early_fraud_warning** | **refund** | **credit_note** | **tax_id** | **subscription_schedules**
- `created` is Stripe.RangeQueryParam. It supports **gt**, **gte**, **lt**, **lte**

### Alternative routes to sync `daily/weekly/monthly` data

```
POST /sync/daily
```

```
POST /sync/daily
body: {
  "object": "product"
}
```

### Syncing single entity

To backfill/update a single entity, you can use:

```
POST /sync/single/cus_12345
```

The entity type is recognized automatically, based on the prefix.

### SSL CA Certificate in Base64 Format

To pass an SSL CA certificate in base64 format for the Dockerized application, follow these steps:

1. Obtain the CA certificate file (e.g., `prod-ca-2021.crt`).
2. Encode it in base64 format using the following command on Unix-based systems:

   ```sh
   base64 -i prod-ca-2021.crt -o CA.base64
   ```

3. Open the `CA.base64` file and copy its contents.
4. Add the base64 string to your environment variables (e.g., `PG_SSL_CA`).
5. Pass the environment variable to the Docker container:

   ```sh
   docker run -d \
     -e DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
     -e PG_SSL_CA="$(cat CA.base64)" \
     -e STRIPE_SECRET_KEY=sk_test_... \
     -e STRIPE_WEBHOOK_SECRET=... \
     -e API_KEY="my-secret" \
     -p 8080:8080 \
     supabase/stripe-sync-engine:latest
   ```

> **Note:** The `PG_SSL_CA` environment variable should contain the base64-encoded CA certificate. The application will decode and use it automatically during runtime.

### Example Usage

To pass these variables to the Docker container, use the following command:

```sh
docker run -d \
  -e DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  -e PG_SSL_CONFIG_ENABLED=true \
  -e PG_SSL_REJECT_UNAUTHORIZED=true \
  -e PG_SSL_CA="$(cat CA.base64)" \
  -e PG_SSL_CERT="$(cat cert.pem)" \
  -e PG_SSL_REQUEST_CERT=true \
  -e STRIPE_SECRET_KEY=sk_test_... \
  -e STRIPE_WEBHOOK_SECRET=... \
  -e API_KEY="my-secret" \
  -p 8080:8080 \
  supabase/stripe-sync-engine:latest
```

> **Note:** Ensure the `PG_SSL_CA` and `PG_SSL_CERT` variables contain valid base64-encoded or PEM-formatted certificates as required.
