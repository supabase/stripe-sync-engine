# Temporal Sync Workflow

Ruby-based Temporal workflow orchestration for the sync engine. All code is isolated here — zero changes to any TypeScript packages. Activities call the existing stateless API over HTTP.

## Architecture

```
Stripe webhook ──▶ webhook_bridge.rb ──signal──▶ SyncWorkflow (Ruby)
                                                   │
                                                   │ activities (HTTP)
                                                   ▼
                                          Stateless API (TS, unchanged)
                                                   │
                                                   ▼
                                          source.read() / destination.write()
```

## Setup

Requires Ruby >= 3.3.

```sh
cd temporal
bundle install
```

## Workflow phases

One `SyncWorkflow` instance per sync. Phases: **setup → backfill → live**.

- **Setup**: health check, then source + destination setup (create tables, webhooks, etc.)
- **Backfill**: pages through each stream via `/read` + `/write` on the stateless API
- **Live**: waits for `stripe_event` signals, processes them through `/read` + `/write`

Signals: `stripe_event`, `pause`, `resume`, `update_config`, `delete`
Query: `status` (returns phase, paused, cursors, iteration count)
Continues-as-new every 500 iterations to shed history.

## Running

```sh
# Start local Temporal server
docker compose up -d

# Start the worker (needs a running stateless API)
ENGINE_URL=http://localhost:3001 ruby lib/worker.rb

# Start the webhook bridge (optional, for live events)
ruby lib/webhook_bridge.rb
```

## Tests

```sh
bundle exec rspec              # unit tests only (stubbed activities, no deps)
bundle exec rspec spec/e2e/    # e2e: requires Stripe API key + local Postgres
```

### Unit tests

Use the SDK's local test server — no Docker needed. All activities are stubbed; tests verify workflow state machine logic (phase transitions, signals, queries).

### E2E tests

Full stack: Temporal workflow → stateless API → Stripe → Postgres. Requires:

- `STRIPE_API_KEY` env var (test-mode key with read access)
- Postgres at `POSTGRES_URL` (default: `postgresql://postgres:postgres@localhost:5432/postgres`)
- `pnpm build` already run (stateless API + connector binaries)

```sh
cd temporal
STRIPE_API_KEY=rk_test_... bundle exec rspec spec/e2e/
```

Two tests:
1. **Backfill** — workflow reads products from Stripe, writes 100 rows to Postgres
2. **Live event** — after backfill, updates a product via Stripe API, signals the event to the workflow, verifies processing

Set `KEEP_TEST_DATA=1` to skip schema cleanup and inspect the data in Postgres after the test.

### State

No migrations or metadata tables — Temporal IS the state store. Workflow memory (cursors, phase, event buffer) is durably persisted via Temporal's event sourcing. Postgres only contains the synced data tables.
