# @supabase/stripe-sync-cli

CLI tool for syncing Stripe data to PostgreSQL with real-time webhook streaming.

## Features

- 🔄 Real-time Stripe webhook streaming to PostgreSQL
- 🚀 Automatic table creation and migrations
- 🌐 Built-in ngrok tunnel for local development
- 🔐 Secure webhook signature verification
- 🧹 Automatic cleanup on exit

## Installation

```bash
npm install -g @supabase/stripe-sync-cli
```

## Usage

### Basic Command

```bash
stripe-sync --database-url postgresql://user:password@localhost:5432/mydb
```

You'll be prompted for:
- Stripe API key (or set `STRIPE_API_KEY` env var)
- ngrok auth token (or set `NGROK_AUTH_TOKEN` env var)
- Postgres DATABASE_URL (or pass via `--database-url` flag)

### Example Output

```
$ stripe-sync postgresql://user:password@localhost:5432/mydb
Creating tables............ ✓
Populating tables.......... ✓
Streaming live changes..... ● [press Ctrl-C to abort]
```

### Command Options

```bash
stripe-sync [options]

Options:
  --stripe-key <key>       Stripe API key (or STRIPE_API_KEY env)
  --ngrok-token <token>    ngrok auth token (or NGROK_AUTH_TOKEN env)
  --database-url <url>     Postgres DATABASE_URL (or DATABASE_URL env)
  -h, --help              Display help
  -V, --version           Display version
```

### Environment Variables

Create a `.env` file in your project:

```env
STRIPE_API_KEY=sk_test_...
NGROK_AUTH_TOKEN=your_ngrok_token
DATABASE_URL=postgresql://user:password@localhost:5432/mydb
```

Then run:

```bash
stripe-sync
```

## How It Works

1. **Creates Tables**: Runs database migrations to create Stripe schema tables
2. **Sets Up Tunnel**: Creates an ngrok tunnel to expose your local server
3. **Registers Webhook**: Creates a Stripe webhook endpoint listening to all events (`*`)
4. **Streams Changes**: Real-time syncing of all Stripe events to PostgreSQL

The CLI automatically:
- Starts a Fastify server with `@supabase/stripe-sync-fastify`
- Creates an ngrok tunnel for webhook delivery
- Registers a Stripe webhook with all events enabled
- Cleans up webhook and tunnel on exit (Ctrl-C)

## Prerequisites

- Node.js >= 22.0.0
- PostgreSQL database
- Stripe API key ([Get one here](https://dashboard.stripe.com/apikeys))
- ngrok auth token ([Sign up here](https://dashboard.ngrok.com/signup))

## What Gets Synced

The CLI syncs all Stripe objects supported by `@supabase/stripe-sync-engine`:

- Customers
- Subscriptions & Subscription Schedules
- Invoices & Invoice Items
- Products & Prices
- Payment Intents & Payment Methods
- Charges & Refunds
- Disputes & Reviews
- And 20+ more object types

## Next Steps / Roadmap

### Backfill Command

Backfill historical Stripe data for a specific time period:

```bash
# Proposed usage (not yet implemented)
stripe-sync backfill --days 1   # Last 24 hours
stripe-sync backfill --days 7   # Last week
stripe-sync backfill --days 30  # Last month
```

This would:
1. Start the server
2. Call the `/sync` endpoint with date range filters
3. Display sync progress and results
4. Shut down after completion

## Troubleshooting

### "Database configuration is required"

Make sure you have set `DATABASE_URL` either via:
- Command flag: `--database-url postgresql://...`
- Environment variable: `DATABASE_URL=postgresql://...`
- Interactive prompt will ask if not provided
- Start a local postgres instance with URL `postgresql://postgres:postgres@localhost:5432/app_db` using Docker by running the following command:

```bash
docker run --name local-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=app_db \
  -p 5432:5432 \
  -d postgres:16
```
Feel free to query it manually using `docker exec -it local-postgres psql -U postgres -d app_db`


### "Failed to create ngrok tunnel"

- Verify your ngrok auth token is valid
- Check if ngrok is blocked by your firewall
- Try running `ngrok config add-authtoken <token>` manually or go to the 

### "Stripe API key should start with 'sk_'"

Make sure you're using a Secret Key (starts with `sk_`), not a Publishable Key (starts with `pk_`).

## Related Packages

- [`@supabase/stripe-sync-engine`](../sync-engine) - Core sync library
- [`@supabase/stripe-sync-fastify`](../fastify-app) - Fastify server for webhooks

## License

Apache-2.0
