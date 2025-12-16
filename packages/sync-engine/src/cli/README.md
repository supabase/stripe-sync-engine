# stripe-experiment-sync CLI

CLI tool for syncing Stripe data to PostgreSQL with real-time webhook streaming and Supabase Edge Functions deployment.

## Features

- 🔄 Real-time Stripe webhook streaming to PostgreSQL
- 🚀 Automatic table creation and migrations
- 🌐 Built-in ngrok tunnel for local development
- 🔐 Secure webhook signature verification
- 🧹 Automatic cleanup on exit
- ☁️ Supabase Edge Functions deployment for serverless webhook handling

## Installation

```bash
npm install -g stripe-experiment-sync
```

## Commands

### Local Development

#### Start Webhook Server

```bash
stripe-experiment-sync start [options]

Options:
  --stripe-key <key>       Stripe API key (or STRIPE_API_KEY env)
  --ngrok-token <token>    ngrok auth token (or NGROK_AUTH_TOKEN env)
  --database-url <url>     Postgres DATABASE_URL (or DATABASE_URL env)
```

Starts a local webhook server with ngrok tunnel for real-time Stripe event syncing.

#### Run Migrations

```bash
stripe-experiment-sync migrate [options]

Options:
  --database-url <url>     Postgres DATABASE_URL (or DATABASE_URL env)
```

Runs database migrations to create Stripe schema tables.

#### Backfill Data

```bash
stripe-experiment-sync backfill <object> [options]

Arguments:
  object                   Stripe object to backfill (e.g., customers, products, prices)

Options:
  --stripe-key <key>       Stripe API key (or STRIPE_API_KEY env)
  --database-url <url>     Postgres DATABASE_URL (or DATABASE_URL env)
```

Backfills historical data from Stripe to PostgreSQL.

### Supabase Deployment

#### Install to Supabase

```bash
stripe-experiment-sync supabase install [options]

Options:
  --token <token>          Supabase access token (or SUPABASE_ACCESS_TOKEN env)
  --project <ref>          Supabase project ref (or SUPABASE_PROJECT_REF env)
  --stripe-key <key>       Stripe API key (or STRIPE_API_KEY env)
  --worker-interval <seconds>  Worker interval in seconds (defaults to 60)
                               Valid values: 1-59 (seconds) or multiples of 60 up to 3540 (59 minutes)
```

Deploys Stripe sync engine as Supabase Edge Functions. The worker interval controls how frequently the pg_cron job invokes the worker function to process sync operations. Intervals of 1-59 seconds use pg_cron's interval format, while minute-based intervals (60, 120, 180, etc.) use cron format.

#### Uninstall from Supabase

```bash
stripe-experiment-sync supabase uninstall [options]

Options:
  --token <token>          Supabase access token (or SUPABASE_ACCESS_TOKEN env)
  --project <ref>          Supabase project ref (or SUPABASE_PROJECT_REF env)
```

Removes Stripe sync Edge Functions from Supabase.

## Environment Variables

Create a `.env` file in your project (see `.env.sample`):

```env
# Required for all commands
STRIPE_API_KEY=sk_test_...
DATABASE_URL=postgresql://user:password@localhost:5432/mydb

# Required for local development (start command)
NGROK_AUTH_TOKEN=your_ngrok_token

# Required for Supabase deployment
SUPABASE_ACCESS_TOKEN=your_supabase_token
SUPABASE_PROJECT_REF=your_project_ref
```

Then run commands without options:

```bash
stripe-experiment-sync start
stripe-experiment-sync migrate
stripe-experiment-sync backfill customers
stripe-experiment-sync supabase install
```

## Usage Examples

### Local Development Workflow

1. **Run migrations**:

   ```bash
   stripe-experiment-sync migrate
   ```

2. **Start webhook server**:

   ```bash
   stripe-experiment-sync start
   ```

   Output:

   ```
   Creating tables............ ✓
   Populating tables.......... ✓
   Streaming live changes..... ● [press Ctrl-C to abort]
   ```

3. **Backfill historical data** (optional):
   ```bash
   stripe-experiment-sync backfill customers
   stripe-experiment-sync backfill products
   ```

### Supabase Deployment Workflow

1. **Deploy to Supabase**:

   ```bash
   # Default: worker runs every 60 seconds
   stripe-experiment-sync supabase install

   # Custom interval: worker runs every 2 minutes
   stripe-experiment-sync supabase install --worker-interval 120
   ```

2. **Update webhook endpoint in Stripe dashboard** to point to your Supabase Edge Function

3. **To remove**:
   ```bash
   stripe-experiment-sync supabase uninstall
   ```

## Testing with Stripe Events

Trigger test Stripe events using the Stripe CLI:

```bash
stripe trigger payment_intent.succeeded
stripe trigger customer.created
stripe trigger subscription.created
```

This uses the [Stripe CLI](https://stripe.com/docs/stripe-cli) to send test webhook events.

**Install Stripe CLI:**

- macOS: `brew install stripe/stripe-cli/stripe`
- Download: https://github.com/stripe/stripe-cli/releases/latest

## How It Works

### Local Development Mode

1. **Creates Tables**: Runs database migrations to create Stripe schema tables
2. **Sets Up Tunnel**: Creates an ngrok tunnel to expose your local server
3. **Registers Webhook**: Creates a Stripe webhook endpoint listening to all events (`*`)
4. **Streams Changes**: Real-time syncing of all Stripe events to PostgreSQL

The CLI automatically:

- Starts an Express server with webhook handling
- Creates an ngrok tunnel for webhook delivery
- Manages webhook lifecycle (creation/cleanup)
- Verifies webhook signatures for security

### Supabase Deployment Mode

1. **Deploys Edge Functions**: Creates webhook and worker Edge Functions
2. **Runs Migrations**: Automatically sets up database schema
3. **Configures Webhooks**: Sets up Stripe webhook endpoints pointing to Supabase
4. **Manages Secrets**: Securely stores Stripe API keys in Supabase

The deployment:

- Uses Supabase's serverless Edge Functions (Deno runtime)
- Connects to your Supabase PostgreSQL database
- Handles webhook signature verification
- Processes events asynchronously via queue

## Troubleshooting

### Webhook Limit Reached

If you hit Stripe's 16 webhook endpoint limit, use the cleanup script:

```bash
npx tsx node_modules/stripe-experiment-sync/dist/scripts/cleanup-webhooks.js
```

### Database Connection Issues

Ensure your `DATABASE_URL` is correct and the database is accessible:

```bash
psql $DATABASE_URL -c "SELECT 1"
```

### Ngrok Authentication

Get your ngrok auth token from: https://dashboard.ngrok.com/get-started/your-authtoken

## Development Scripts

The package includes several test scripts for development:

- `scripts/test-integration-webhooks.sh` - Test webhook processing
- `scripts/test-integration-webhook-reuse.sh` - Test webhook reuse functionality
- `scripts/test-integration-backfill.sh` - Test backfill operations
- `scripts/test-integration-recoverable-backfill.sh` - Test error recovery
- `scripts/cleanup-deploy.sh` - Clean up test deployments
- `scripts/cleanup-webhooks.ts` - Remove test webhooks from Stripe

## License

MIT
