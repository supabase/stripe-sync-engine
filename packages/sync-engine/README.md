# Stripe Sync Engine

![GitHub License](https://img.shields.io/github/license/tx-stripe/stripe-sync-engine)
![NPM Version](https://img.shields.io/npm/v/stripe-replit-sync)

A TypeScript library to synchronize Stripe data into a PostgreSQL database, designed for use in Node.js backends and serverless environments.

## Features

- Automatically manages Stripe webhooks for real-time updates
- Sync Stripe objects (customers, invoices, products, etc.) to your PostgreSQL database
- Automatic database migrations
- Express middleware integration with automatic body parsing
- UUID-based webhook routing for security

## Installation

```sh
npm install stripe-replit-sync stripe
# or
pnpm add stripe-replit-sync stripe
# or
yarn add stripe-replit-sync stripe
```

## StripeAutoSync

The easiest way to integrate Stripe sync into your Express application:

```typescript
import { StripeAutoSync } from 'stripe-experiment-sync'

// baseUrl is a function for dynamic URL generation
// (e.g., for ngrok tunnels, Replit domains, or environment-based URLs)
const getPublicUrl = () => {
  if (process.env.PUBLIC_URL) {
    return process.env.PUBLIC_URL
  }
  // Or dynamically determine from request, ngrok, etc.
  return `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`
}

const stripeAutoSync = new StripeAutoSync({
  databaseUrl: process.env.DATABASE_URL,
  stripeApiKey: process.env.STRIPE_SECRET_KEY,
  baseUrl: getPublicUrl,
})

await stripeAutoSync.start(app) // Express app
// ... later
await stripeAutoSync.stop() // Cleanup
```

### Configuration Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `databaseUrl` | Yes | - | PostgreSQL connection string |
| `stripeApiKey` | Yes | - | Stripe secret key (sk_...) |
| `baseUrl` | Yes | - | Function returning your public URL |
| `webhookPath` | No | `/stripe-webhooks` | Path where webhook handler is mounted |
| `schema` | No | `stripe` | Database schema name |
| `stripeApiVersion` | No | `2020-08-27` | Stripe API version |

## Low-Level API (Advanced)

For more control, you can use the `StripeSync` class directly:

```ts
import { StripeSync } from 'stripe-experiment-sync'

const sync = new StripeSync({
  poolConfig: {
    connectionString: 'postgres://user:pass@host:port/db',
    max: 10, // Maximum number of connections
  },
  stripeSecretKey: 'sk_test_...',
  stripeWebhookSecret: 'whsec_...',
  // logger: <a pino logger>
})

// Example: process a Stripe webhook
await sync.processWebhook(payload, signature)
```

## Configuration

| Option                          | Type    | Description                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `databaseUrl`                   | string  | **Deprecated:** Use `poolConfig` with a connection string instead.                                                                                                                                                                                                                                       |
| `schema`                        | string  | Database schema name (default: `stripe`)                                                                                                                                                                                                                                                                 |
| `stripeSecretKey`               | string  | Stripe secret key                                                                                                                                                                                                                                                                                        |
| `stripeWebhookSecret`           | string  | Stripe webhook signing secret                                                                                                                                                                                                                                                                            |
| `stripeApiVersion`              | string  | Stripe API version (default: `2020-08-27`)                                                                                                                                                                                                                                                               |
| `autoExpandLists`               | boolean | Fetch all list items from Stripe (not just the default 10)                                                                                                                                                                                                                                               |
| `backfillRelatedEntities`       | boolean | Ensure related entities are present for foreign key integrity                                                                                                                                                                                                                                            |
| `revalidateObjectsViaStripeApi` | Array   | Always fetch latest entity from Stripe instead of trusting webhook payload, possible values: charge, credit_note, customer, dispute, invoice, payment_intent, payment_method, plan, price, product, refund, review, radar.early_fraud_warning, setup_intent, subscription, subscription_schedule, tax_id |
| `poolConfig`                    | object  | Configuration for PostgreSQL connection pooling. Supports options like `connectionString`, `max`, and `keepAlive`. For more details, refer to the [Node-Postgres Pool API documentation](https://node-postgres.com/apis/pool).                                                                           |
| `maxPostgresConnections`        | number  | **Deprecated:** Use `poolConfig.max` instead to configure the maximum number of PostgreSQL connections.                                                                                                                                                                                                  |
| `logger`                        | Logger  | Logger instance (pino)                                                                                                                                                                                                                                                                                   |

## Database Schema

The library will create and manage a `stripe` schema in your PostgreSQL database, with tables for all supported Stripe objects (products, customers, invoices, etc.).

### Migrations

Migrations are included in the `db/migrations` directory. You can run them using the provided `runMigrations` function:

```ts
import { runMigrations } from '@supabase/stripe-sync-engine'

await runMigrations({ databaseUrl: 'postgres://...' })
```

## Backfilling and Syncing Data

### Syncing a Single Entity

You can sync or update a single Stripe entity by its ID using the `syncSingleEntity` method:

```ts
await sync.syncSingleEntity('cus_12345')
```

The entity type is detected automatically based on the Stripe ID prefix (e.g., `cus_` for customer, `prod_` for product). `ent_` is not supported at the moment.

### Backfilling Data

To backfill Stripe data (e.g., all products created after a certain date), use the `syncBackfill` method:

```ts
await sync.syncBackfill({
  object: 'product',
  created: { gte: 1643872333 }, // Unix timestamp
})
```

- `object` can be one of: `all`, `charge`, `customer`, `dispute`, `invoice`, `payment_method`, `payment_intent`, `plan`, `price`, `product`, `setup_intent`, `subscription`.
- `created` is a Stripe RangeQueryParam and supports `gt`, `gte`, `lt`, `lte`.

> **Note:**
> For large Stripe accounts (more than 10,000 objects), it is recommended to write a script that loops through each day and sets the `created` date filters to the start and end of day. This avoids timeouts and memory issues when syncing large datasets.
