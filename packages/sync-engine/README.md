# Stripe Sync Engine

![GitHub License](https://img.shields.io/github/license/stripe-experiments/sync-engine)
![NPM Version](https://img.shields.io/npm/v/stripe-experiment-sync)

A TypeScript library to synchronize Stripe data into a PostgreSQL database, designed for use in Node.js backends and serverless environments.

## Features

- **Managed Webhooks:** Automatic webhook creation and lifecycle management with built-in processing
- **Real-time Sync:** Keep your database in sync with Stripe automatically
- **Backfill Support:** Sync historical data from Stripe to your database
- **Stripe Sigma:** Support for Stripe Sigma reporting data
- **Supabase Ready:** Deploy to Supabase Edge Functions with one command
- **Automatic Retries:** Built-in retry logic for rate limits and transient errors
- **Observability:** Track sync runs and monitor progress

## Installation

```sh
npm install stripe-experiment-sync stripe
# or
pnpm add stripe-experiment-sync stripe
# or
yarn add stripe-experiment-sync stripe
```

## Quick Start

```ts
import { StripeSync } from 'stripe-experiment-sync'

const sync = new StripeSync({
  poolConfig: {
    connectionString: 'postgres://user:pass@host:port/db',
    max: 10,
  },
  stripeSecretKey: 'sk_test_...',
})

// Create a managed webhook - no additional processing needed!
const webhook = await sync.findOrCreateManagedWebhook('https://example.com/stripe-webhooks')

// Cleanup when done (closes PostgreSQL connection pool)
await sync.close()
```

## Managed Webhooks

The Stripe Sync Engine automatically manages webhook endpoints and their processing. Once created, managed webhooks handle everything automatically - you don't need to manually process events.

### Creating Managed Webhooks

```typescript
// Create or reuse an existing webhook endpoint
// This webhook will automatically sync all Stripe events to your database
const webhook = await sync.findOrCreateManagedWebhook('https://example.com/stripe-webhooks')

// Create a webhook for specific events
const webhook = await sync.createManagedWebhook('https://example.com/stripe-webhooks', {
  enabled_events: ['customer.created', 'customer.updated', 'invoice.paid'],
})

console.log(webhook.id) // we_xxx
console.log(webhook.secret) // whsec_xxx
```

**⚠️ Important:** Managed webhooks are tracked in the database and automatically process incoming events. You don't need to call `processWebhook()` for managed webhooks - the library handles this internally.

### Managing Webhooks

```typescript
// List all managed webhooks
const webhooks = await sync.listManagedWebhooks()

// Get a specific webhook
const webhook = await sync.getManagedWebhook('we_xxx')

// Delete a managed webhook
await sync.deleteManagedWebhook('we_xxx')
```

### How It Works

**Automatic Processing:** Managed webhooks are stored in the `stripe._managed_webhooks` table. When Stripe sends events to these webhooks, they are automatically processed and synced to your database.

**Race Condition Protection:** PostgreSQL advisory locks prevent race conditions when multiple instances call `findOrCreateManagedWebhook()` concurrently. A unique constraint on `(url, account_id)` provides additional safety.

**Automatic Cleanup:** When you call `findOrCreateManagedWebhook()`, it will:

1. Check if a webhook already exists for the URL in the database
2. If found, reuse the existing webhook
3. If not found, create a new webhook in Stripe and record it
4. Clean up any orphaned webhooks from previous installations

## Manual Webhook Processing

If you need to process webhooks outside of managed webhooks (e.g., for testing or custom integrations):

```typescript
// Validate and process a webhook event
app.post('/stripe-webhooks', async (req, res) => {
  const signature = req.headers['stripe-signature']
  const payload = req.body

  try {
    await sync.processWebhook(payload, signature)
    res.status(200).send({ received: true })
  } catch (error) {
    res.status(400).send({ error: error.message })
  }
})

// Or process an event directly (no signature validation)
await sync.processEvent(stripeEvent)

// Cleanup when done
await sync.close()
```

**Note:** This is only needed for custom webhook endpoints. Managed webhooks handle processing automatically.

## Configuration

| Option                          | Type    | Description                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `poolConfig`                    | object  | **Required.** PostgreSQL connection pool configuration. Supports `connectionString`, `max`, `keepAlive`. See [Node-Postgres Pool API](https://node-postgres.com/apis/pool).                                                                                                                            |
| `stripeSecretKey`               | string  | **Required.** Stripe secret key                                                                                                                                                                                                                                                                        |
| `stripeWebhookSecret`           | string  | Stripe webhook signing secret (only needed for manual webhook processing)                                                                                                                                                                                                                              |
| `stripeApiVersion`              | string  | Stripe API version (default: `2020-08-27`)                                                                                                                                                                                                                                                             |
| `enableSigma`                   | boolean | Enable Stripe Sigma reporting data sync. Default: false                                                                                                                                                                                                                                                |
| `autoExpandLists`               | boolean | Fetch all list items from Stripe (not just the default 10)                                                                                                                                                                                                                                             |
| `backfillRelatedEntities`       | boolean | Ensure related entities exist for foreign key integrity                                                                                                                                                                                                                                                |
| `revalidateObjectsViaStripeApi` | Array   | Always fetch latest data from Stripe instead of trusting webhook payload. Possible values: charge, credit_note, customer, dispute, invoice, payment_intent, payment_method, plan, price, product, refund, review, radar.early_fraud_warning, setup_intent, subscription, subscription_schedule, tax_id |
| `maxRetries`                    | number  | Maximum retry attempts for 429 rate limits. Default: 5                                                                                                                                                                                                                                                 |
| `initialRetryDelayMs`           | number  | Initial retry delay in milliseconds. Default: 1000                                                                                                                                                                                                                                                     |
| `maxRetryDelayMs`               | number  | Maximum retry delay in milliseconds. Default: 60000                                                                                                                                                                                                                                                    |
| `logger`                        | Logger  | Logger instance (pino-compatible)                                                                                                                                                                                                                                                                      |

## Database Schema

The library creates and manages a `stripe` schema in PostgreSQL with tables for all supported Stripe objects.

> **Important:** The schema name is fixed as `stripe` and cannot be configured.

> **Note:** Fields and tables prefixed with `_` are reserved for internal metadata: `_account_id`, `_last_synced_at`, `_updated_at`, `_migrations`, `_managed_webhooks`, `_sync_runs`, `_sync_obj_runs`.

### Running Migrations

```ts
import { runMigrations } from 'stripe-experiment-sync'

await runMigrations({ databaseUrl: 'postgres://...' })
```

### Observability

Track sync operations with the `sync_runs` view:

```sql
SELECT
  account_id,
  started_at,
  closed_at,
  status,              -- 'running', 'complete', or 'error'
  total_processed,     -- Total records synced
  complete_count,      -- Completed object types
  error_count,         -- Object types with errors
  running_count,       -- Currently syncing
  pending_count        -- Not yet started
FROM stripe.sync_runs
ORDER BY started_at DESC;
```

## Syncing Data

### Sync a Single Entity

```ts
// Automatically detects entity type from ID prefix
await sync.syncSingleEntity('cus_12345')
await sync.syncSingleEntity('prod_xyz')
```

### Backfill Historical Data

```ts
// Sync all products created after a date
await sync.processUntilDone({
  object: 'product',
  created: { gte: 1643872333 }, // Unix timestamp
})

// Sync all customers
await sync.processUntilDone({ object: 'customer' })

// Sync everything
await sync.processUntilDone({ object: 'all' })
```

Supported objects: `all`, `charge`, `checkout_sessions`, `credit_note`, `customer`, `customer_with_entitlements`, `dispute`, `early_fraud_warning`, `invoice`, `payment_intent`, `payment_method`, `plan`, `price`, `product`, `refund`, `setup_intent`, `subscription`, `subscription_schedules`, `tax_id`.

The sync engine tracks cursors per account and resource, enabling incremental syncing that resumes after interruptions.

For paged backfills, the engine keeps a separate per-run pagination cursor (`page_cursor`) while the
incremental cursor continues to track the highest `created` timestamp.

> **Tip:** For large Stripe accounts (>10,000 objects), loop through date ranges day-by-day to avoid timeouts.

## Account Management

### Get Current Account

```ts
const account = await sync.getCurrentAccount()
console.log(account.id) // acct_xxx
```

### List Synced Accounts

```ts
const accounts = await sync.getAllSyncedAccounts()
```

### Delete Account Data

**⚠️ WARNING:** This permanently deletes all synced data for an account.

```ts
// Preview deletion
const preview = await sync.dangerouslyDeleteSyncedAccountData('acct_xxx', {
  dryRun: true,
})
console.log(preview.deletedRecordCounts)

// Actually delete
const result = await sync.dangerouslyDeleteSyncedAccountData('acct_xxx')
```

## Supabase Deployment

Deploy to Supabase Edge Functions for serverless operation with automatic webhook processing:

```bash
# Install
npx stripe-experiment-sync supabase install \
  --token $SUPABASE_ACCESS_TOKEN \
  --project $SUPABASE_PROJECT_REF \
  --stripe-key $STRIPE_API_KEY

# Install specific version
npx stripe-experiment-sync supabase install \
  --token $SUPABASE_ACCESS_TOKEN \
  --project $SUPABASE_PROJECT_REF \
  --stripe-key $STRIPE_API_KEY \
  --package-version 1.0.15

# Uninstall
npx stripe-experiment-sync supabase uninstall \
  --token $SUPABASE_ACCESS_TOKEN \
  --project $SUPABASE_PROJECT_REF
```

### Install Options

- `--token <token>` - Supabase access token (or `SUPABASE_ACCESS_TOKEN` env)
- `--project <ref>` - Supabase project ref (or `SUPABASE_PROJECT_REF` env)
- `--stripe-key <key>` - Stripe API key (or `STRIPE_API_KEY` env)
- `--package-version <version>` - npm package version (default: latest)
- `--worker-interval <seconds>` - Worker interval in seconds (default: 60)
- `--management-url <url>` - Supabase management API URL with protocol (default: https://api.supabase.com). For local testing: http://localhost:54323

The install command will:

1. Deploy Edge Functions: `stripe-setup`, `stripe-webhook`, `stripe-worker`
2. Run database migrations to create the `stripe` schema
3. Create a managed Stripe webhook pointing to your Supabase project
4. Set up a pg_cron job for automatic background syncing

## CLI Commands

```bash
# Run database migrations
npx stripe-experiment-sync migrate --database-url $DATABASE_URL

# Start local sync with ngrok tunnel
npx stripe-experiment-sync start \
  --stripe-key $STRIPE_API_KEY \
  --ngrok-token $NGROK_AUTH_TOKEN \
  --database-url $DATABASE_URL

# Backfill specific entity type
npx stripe-experiment-sync backfill customer \
  --stripe-key $STRIPE_API_KEY \
  --database-url $DATABASE_URL

# Enable Sigma data syncing
npx stripe-experiment-sync start \
  --stripe-key $STRIPE_API_KEY \
  --database-url $DATABASE_URL \
  --sigma
```

## License

See [LICENSE](LICENSE) file.

## Contributing

Issues and pull requests are welcome at [https://github.com/stripe-experiments/sync-engine](https://github.com/stripe-experiments/sync-engine).
