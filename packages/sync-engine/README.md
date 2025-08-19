# Stripe Sync Engine

![GitHub License](https://img.shields.io/github/license/supabase/stripe-sync-engine)
![NPM Version](https://img.shields.io/npm/v/%40supabase%2Fstripe-sync-engine)

A TypeScript library to synchronize Stripe data into a Postgres database, designed for use in Node.js backends and serverless environments.

## Features

- Sync Stripe objects (customers, invoices, products, etc.) to your Postgres database.
- Handles Stripe webhooks for real-time updates.
- Supports backfilling and entity revalidation.

## Installation

```sh
npm install @supabase/stripe-sync-engine stripe
# or
pnpm add @supabase/stripe-sync-engine stripe
# or
yarn add @supabase/stripe-sync-engine stripe
```

## Usage

```ts
import { StripeSync } from '@supabase/stripe-sync-engine'

const sync = new StripeSync({
  databaseUrl: 'postgres://user:pass@host:port/db',
  stripeSecretKey: 'sk_test_...',
  stripeWebhookSecret: 'whsec_...',
  // logger: <a pino logger>
})

// Example: process a Stripe webhook
await sync.processWebhook(payload, signature)
```

## Configuration

| Option                         | Type    | Description                                                                |
| ------------------------------ | ------- | -------------------------------------------------------------------------- |
| `databaseUrl`                  | string  | Postgres connection string                                                 |
| `schema`                       | string  | Database schema name (default: `stripe`)                                   |
| `stripeSecretKey`              | string  | Stripe secret key                                                          |
| `stripeWebhookSecret`          | string  | Stripe webhook signing secret                                              |
| `stripeApiVersion`             | string  | Stripe API version (default: `2020-08-27`)                                 |
| `autoExpandLists`              | boolean | Fetch all list items from Stripe (not just the default 10)                 |
| `backfillRelatedEntities`      | boolean | Ensure related entities are present for foreign key integrity              |
| `revalidateEntityViaStripeApi` | boolean | Always fetch latest entity from Stripe instead of trusting webhook payload |
| `maxPostgresConnections`       | number  | Maximum Postgres connections                                               |
| `logger`                       | Logger  | Logger instance (pino)                                                     |

## Database Schema

The library will create and manage a `stripe` schema in your Postgres database, with tables for all supported Stripe objects (products, customers, invoices, etc.).

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
