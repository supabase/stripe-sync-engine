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
bundle exec rspec
```

Tests use the SDK's local test server — no Docker needed. All activities are stubbed; tests verify workflow state machine logic (phase transitions, signals, queries) only.

## What's not tested yet

- Activities making real HTTP calls to the stateless API
- Webhook bridge routing
- End-to-end flow
