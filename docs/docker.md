# With Docker

![GitHub License](https://img.shields.io/github/license/supabase/stripe-sync-engine)
![Docker Image Version](https://img.shields.io/docker/v/supabase/stripe-sync-engine?label=Docker)

A Fastify-based server for syncing your Stripe account to a Postgres database in real time. Built on top of the Stripe Sync Engine.

## Features

- Exposes a `/webhooks` endpoint to receive Stripe webhooks and sync data to Postgres
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

| Variable                           | Description                                                         | Required |
| ---------------------------------- | ------------------------------------------------------------------- | -------- |
| `DATABASE_URL`                     | Postgres connection string (with `search_path=stripe`)              | Yes      |
| `STRIPE_WEBHOOK_SECRET`            | Stripe webhook signing secret                                       | Yes      |
| `API_KEY`                          | API key for admin endpoints (backfilling, etc.)                     | Yes      |
| `SCHEMA`                           | Database schema name (default: `stripe`)                            | No       |
| `STRIPE_SECRET_KEY`                | Stripe secret key (needed for active sync/backfill)                 | No       |
| `PORT`                             | Port to run the server on (default: 8080)                           | No       |
| `STRIPE_API_VERSION`               | Stripe API version (default: `2020-08-27`)                          | No       |
| `AUTO_EXPAND_LISTS`                | Fetch all list items from Stripe (default: false)                   | No       |
| `BACKFILL_RELATED_ENTITIES`        | Backfill related entities for foreign key integrity (default: true) | No       |
| `MAX_POSTGRES_CONNECTIONS`         | Max Postgres connection pool size (default: 10)                     | No       |
| `REVALIDATE_OBJECTS_VIA_STRIPE_API` | Always fetch latest entity from Stripe (default: false)             | No       |

## Endpoints

- `POST /webhooks` — Receives Stripe webhook events and syncs data to Postgres
- `GET /health` — Health check endpoint
- `POST /sync` — Backfill Stripe data to Postgres (API key required)
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

#### Alternative routes to sync `daily/weekly/monthly` data

```
POST /sync/daily

---

POST /sync/daily
body: {
  "object": "product"
}
```

### Syncing single entity

To backfill/update a single entity, you can use

```
POST /sync/single/cus_12345
```

The entity type is recognized automatically, based on the prefix.
