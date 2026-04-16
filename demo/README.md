# Demo Scripts

Sync Stripe data to Postgres (or Google Sheets) from source in under 5 minutes.

## Setup

```sh
git clone git@github.com:stripe/sync-engine.git
cd sync-engine

# nvm (Node version manager) — skip if you already have it
# see https://github.com/nvm-sh/nvm?tab=readme-ov-file#installing-and-updating
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

# Node 24+
nvm install 24
nvm use 24

# pnpm (auto-provided via corepack)
corepack enable
pnpm install
```

## Environment variables

Create a `.env` file (or export directly):

```sh
# Required for most demos
STRIPE_API_KEY=sk_test_...        # Stripe Dashboard → Developers → API keys (test mode)
DATABASE_URL=postgresql://...      # Any Postgres connection string

# Google Sheets demos only
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GOOGLE_SPREADSHEET_ID=...         # optional — creates a new spreadsheet if omitted
```

## Get a Postgres database

Any of these work:

- **Docker:** `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17`
  → `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres`
- **Supabase / Neon / etc.** — any hosted Postgres
- **Stripe Projects:** [projects.dev](https://projects.dev)

## Step 1: Read from Stripe

The source connector reads from the Stripe API and outputs NDJSON to stdout:

```sh
export STRIPE_API_KEY=sk_test_...

./demo/read-from-stripe.sh
```

You'll see a stream of JSON records — one per line — for each Stripe object.

## Step 2: Write to Postgres

The destination connector reads NDJSON from stdin and writes to Postgres:

```sh
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres

./demo/write-to-postgres.sh
```

Without piped input, this uses built-in sample data to create a `demo` table.

## Step 3: Pipe them together

Source and destination are independent processes that communicate via NDJSON.
Pipe one into the other:

```sh
./demo/read-from-stripe.sh | ./demo/write-to-postgres.sh
```

This reads products from Stripe and writes them directly into Postgres.

## Step 4: Use the sync engine

The above pipes work, but the engine sits between source and destination to handle state management, validation, and resumability.

```sh
export STRIPE_API_KEY=sk_test_...
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres

./demo/stripe-to-postgres.sh
```

This syncs `products`, `prices`, and `customers` into Postgres with full schema management.

## Step 5: Live mode (WebSocket streaming)

The engine can keep running after the initial backfill and stream live events
via Stripe's WebSocket API (the same mechanism behind `stripe listen`). Any
object you create, update, or delete in the Stripe Dashboard (or via the API)
is written to Postgres within seconds.

```sh
export STRIPE_API_KEY=sk_test_...
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres

./demo/stripe-to-postgres-live.sh
```

The script backfills the latest 10 objects per stream, then blocks and waits
for live events. Open a second terminal to trigger some:

```sh
# Using the Stripe CLI (https://docs.stripe.com/stripe-cli)
stripe trigger customer.created
stripe trigger product.created
stripe trigger price.created
```

You'll see the new records appear in Postgres immediately.
Press **Ctrl+C** to stop.

### How it works

Setting `websocket: true` in the source config tells the Stripe source to open
a WebSocket session to Stripe (via the same `/v1/stripecli/sessions` API the
Stripe CLI uses). During backfill, incoming events are queued; once backfill
completes the engine drains the queue and then blocks on new events indefinitely.

No webhook endpoint, tunnel, or public URL is needed — everything runs over an
outbound WebSocket connection.

## All demos

| Script                       | What it does                                         | Required env vars                |
| ---------------------------- | ---------------------------------------------------- | -------------------------------- |
| `read-from-stripe.sh`        | Read from Stripe, output NDJSON to stdout            | `STRIPE_API_KEY`                 |
| `write-to-postgres.sh`       | Write NDJSON (stdin or sample data) to Postgres      | `DATABASE_URL`                   |
| `write-to-sheets.sh`         | Write NDJSON (stdin or sample data) to Google Sheets | `GOOGLE_*`                       |
| `stripe-to-postgres.sh`      | Stripe → Postgres via the engine                     | `STRIPE_API_KEY`, `DATABASE_URL` |
| `stripe-to-google-sheets.sh` | Stripe → Google Sheets via the engine                | `STRIPE_API_KEY`, `GOOGLE_*`     |
| `stripe-to-postgres-live.sh` | Stripe → Postgres with live WebSocket streaming      | `STRIPE_API_KEY`, `DATABASE_URL` |

### TypeScript API

The `.ts` files do the same thing using the engine as a library / during development.

```sh
node --import tsx demo/stripe-to-postgres.ts
node --import tsx demo/stripe-to-google-sheets.ts
node --import tsx demo/stripe-to-postgres-live.ts   # live WebSocket mode
```

## Utilities

| Script              | What it does                                     |
| ------------------- | ------------------------------------------------ |
| `reset-postgres.sh` | Drop all tables and non-system schemas           |
| `webhooksite.sh`    | Set up webhook forwarding for live Stripe events |
