# With TypeScript

A TypeScript library to synchronize Stripe data into a PostgreSQL database, designed for use in Node.js backends and serverless environments.

## Features

- Sync Stripe objects (customers, invoices, products, etc.) to your PostgreSQL database.
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
| `poolConfig`                    | object  | Configuration for the PostgreSQL connection pool. Supports options like `connectionString`, `max`, and `keepAlive`.                                                                                                                                                                                      |
| `maxPostgresConnections`        | number  | **Deprecated:** Use `poolConfig.max` instead to configure the maximum number of PostgreSQL connections.                                                                                                                                                                                                  |
| `logger`                        | Logger  | Logger instance (pino)                                                                                                                                                                                                                                                                                   |

### Example `poolConfig`

```typescript
const config = {
  poolConfig: {
    connectionString: 'postgresql://user:password@localhost:5432/mydb',
    max: 20, // Maximum number of connections
    keepAlive: true, // Keep connections alive
  },
}
```

For more details, refer to the [Node-Postgres Pool API documentation](https://node-postgres.com/apis/pool).

### SSL CA Certificate in Base64 Format

```typescript
const config = {
  poolConfig: {
    // optional SSL configuration
    ssl: {
      ca: Buffer.from(process.env.SSL_CA_CERT).toString('utf-8'),
    },
  },
}
```

> **Note:**
> Replace `<base64-encoded-ca>` with your actual base64-encoded certificate (development only) or the environment variable containing it (recommended for production).

### Generating Base64 from CA Certificate

To generate a base64-encoded CA certificate, follow these steps:

1. Obtain the CA certificate file (e.g., `prod-ca-2021.crt`).
2. Use the following command on Unix-based systems:

   ```sh
   base64 -i prod-ca-2021.crt -o CA.base64
   ```

3. Open the `CA.base64` file and copy its contents.
4. Use the base64 string in your configuration or environment variables.

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

The entity type is detected automatically based on the Stripe ID prefix (e.g., `cus_` for customer, `prod_` for product).

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

## Cleanup

Call `close()` to release database connections when shutting down:

```ts
await sync.close()
```
