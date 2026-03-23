# Temporal Ruby — Architecture

## System Overview

The Temporal Ruby worker orchestrates sync-engine workflows using
[Temporal's](https://temporal.io/) durable execution model. It is a pure
orchestration layer — **all connector logic stays in TypeScript** and is
accessed over HTTP via the stateless API.

```
                          Temporal Server
                         ┌───────────────────────────────────────────┐
                         │  Workflow History (event-sourced state)   │
                         │  Task Queue: sync-engine                 │
                         └──────────┬────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
               ┌────▼────┐   ┌─────▼─────┐   ┌─────▼─────┐
               │ Worker   │   │ Worker    │   │ Worker    │
               │ (Ruby)   │   │ (Ruby)    │   │ (Ruby)    │
               └────┬─────┘   └─────┬─────┘   └─────┬─────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    │ HTTP (Faraday)
                                    ▼
                         ┌─────────────────────┐
                         │  Stateless API (TS)  │
                         │  /check /setup       │
                         │  /read  /write       │
                         │  /teardown           │
                         └──────┬───────┬───────┘
                                │       │
                     ┌──────────┘       └──────────┐
                     ▼                              ▼
              ┌─────────────┐               ┌─────────────┐
              │ Source       │               │ Destination  │
              │ (Stripe)    │               │ (Postgres)   │
              └──────┬──────┘               └──────┬───────┘
                     │                              │
                     ▼                              ▼
              Stripe API                     PostgreSQL
```

### Key principle

One workflow = one sync = one destination. The workflow owns the full
lifecycle: setup, backfill, live event processing, and teardown.

---

## Components

### 1. Worker (`lib/worker.rb`)

Entry point. Connects to Temporal, registers the workflow and all
activities, then polls the `sync-engine` task queue forever.

```
ENV vars:
  TEMPORAL_ADDRESS    (default: localhost:7233)
  TEMPORAL_NAMESPACE  (default: default)
  ENGINE_URL          (default: http://localhost:3001)
```

### 2. SyncWorkflow (`lib/workflows/sync_workflow.rb`)

The core state machine. Runs as a Temporal workflow with durable execution
— all `@instance` variables survive crashes and replays.

```
┌──────────────────────────────────────────────────────────────┐
│                        SyncWorkflow                          │
│                                                              │
│  State:                                                      │
│    @config        — sync configuration (source, dest, etc.)  │
│    @cursors       — per-stream pagination cursors             │
│    @phase         — setup | backfill | live                   │
│    @paused        — boolean, toggled by pause/resume signals  │
│    @deleted       — boolean, set by delete signal             │
│    @event_buffer  — queue of Stripe events for live phase     │
│    @iteration     — counter for continue-as-new threshold     │
│                                                              │
│  Signals (durable, survive replays):                         │
│    stripe_event(event)  — enqueue event for live processing  │
│    pause                — block at next wait point            │
│    resume               — unblock                             │
│    update_config(cfg)   — merge new config                    │
│    delete               — trigger teardown and exit           │
│                                                              │
│  Queries (read-only):                                        │
│    status → { phase, paused, cursors, iteration }            │
└──────────────────────────────────────────────────────────────┘
```

#### Phase state machine

```
         ┌─────────────────────────────────────────────────┐
         │                                                 │
         ▼                                                 │
      ┌──────┐     ┌──────────┐     ┌──────┐     ┌────────┴──┐
 ──▶  │SETUP │──▶  │ BACKFILL │──▶  │ LIVE │──▶  │ TEARDOWN  │
      └──┬───┘     └────┬─────┘     └──┬───┘     └───────────┘
         │              │              │                ▲
         │   delete     │   delete     │   delete       │
         └──────────────┴──────────────┴────────────────┘
```

**Setup** — sequential, fail-fast:

1. `HealthCheck` — GET /check (validates source + destination connectivity)
2. `SourceSetup` — POST /setup (e.g. register Stripe webhook endpoint)
3. `DestinationSetup` — POST /setup (e.g. create Postgres schema + tables)

**Backfill** — per stream, paginated:

```
for each stream in config.streams:
  loop:
    check_paused()          # blocks if paused
    break if @deleted
    page = BackfillPage()   # POST /read with cursor
    break if page.empty?
    WriteBatch(page)        # POST /write
    update_cursors()
    tick_iteration()        # continue-as-new at 500
    break if stream_complete?
```

**Live** — infinite event loop:

```
loop:
  wait_for_events_or_timeout(60s)
  break if @deleted
  batch = event_buffer.shift(50)    # max 50 per batch
  for each event in batch:
    ProcessEvent(event)             # POST /read → POST /write
    update_cursors()
    tick_iteration()
```

**Teardown** — always runs on delete (even mid-backfill):

1. `DestinationTeardown` — POST /teardown (drop schema)
2. `SourceTeardown` — POST /teardown (remove webhook)

#### Continue-as-new

Every 500 iterations, the workflow raises `ContinueAsNewError` with its
current state (`@config`, `@cursors`, `@phase`, `@event_buffer`). This
restarts the workflow with a fresh event history, preventing unbounded
history growth during long-running syncs.

---

### 3. Activities (`lib/activities/sync_activities.rb`)

Eight activity classes, all including the `EngineClient` mixin (Faraday
HTTP client + NDJSON parsing). Activities are **thin HTTP wrappers** — they
call the stateless API and categorize the NDJSON response.

```
┌────────────────────┬────────┬───────────┬─────────────────────────────────┐
│ Activity           │ Method │ Endpoint  │ Purpose                         │
├────────────────────┼────────┼───────────┼─────────────────────────────────┤
│ HealthCheck        │ GET    │ /check    │ Validate connectivity           │
│ SourceSetup        │ POST   │ /setup    │ Create webhook, etc.            │
│ DestinationSetup   │ POST   │ /setup    │ Create schema/tables            │
│ BackfillPage       │ POST   │ /read     │ Fetch one page (with cursor)    │
│ WriteBatch         │ POST   │ /write    │ Write records to destination    │
│ ProcessEvent       │ POST   │ /read+    │ Source processes event, then    │
│                    │        │  /write   │ destination writes results      │
│ SourceTeardown     │ POST   │ /teardown │ Remove webhook                  │
│ DestinationTeardown│ POST   │ /teardown │ Drop schema                     │
└────────────────────┴────────┴───────────┴─────────────────────────────────┘
```

#### HTTP protocol

All endpoints receive sync params as a JSON-serialized header:

```
POST /read HTTP/1.1
X-Sync-Params: {"source_name":"stripe","destination_name":"postgres",...}
Content-Type: application/x-ndjson

(optional NDJSON body — e.g. webhook event for ProcessEvent)
```

Responses are NDJSON streams. Activities parse them into categorized
message bags:

```ruby
{
  'records'         => [...],  # data rows
  'states'          => [...],  # cursor checkpoints
  'errors'          => [...],  # sync errors
  'stream_statuses' => [...],  # stream completion markers
  'messages'        => [...]   # all raw messages
}
```

#### Retry policy

```
initial_interval:    1s
backoff_coefficient: 2x
max_interval:        300s (5 min)
max_attempts:        10
```

Timeouts vary by activity type:

- Health check: 30s
- Setup/teardown: 120s
- Backfill/write: 300s (with 60s heartbeat)

---

### 4. Webhook Bridge (`lib/webhook_bridge.rb`)

Separate WEBrick HTTP server that receives Stripe webhooks and fans them
out to matching workflows via Temporal signals.

```
Stripe ──POST /webhooks──▶ Webhook Bridge ──signal──▶ SyncWorkflow(s)
                           (port 8088)

Flow:
  1. Parse event JSON
  2. Extract account_id from event
  3. Query Temporal:
       WorkflowType = 'SyncWorkflow'
       AND AccountId = '{account_id}'
       AND ExecutionStatus = 'Running'
  4. Signal each matching workflow: stripe_event(event)
```

One webhook can fan out to multiple workflows (multiple syncs for the
same Stripe account). Workflows that have already completed are silently
skipped.

```
ENV vars:
  TEMPORAL_ADDRESS       (default: localhost:7233)
  TEMPORAL_NAMESPACE     (default: default)
  WEBHOOK_BRIDGE_PORT    (default: 8088)
```

---

## State model

**Temporal IS the state store.** There is no migrations table, no
`_sync_runs`, no `_managed_webhooks` in Postgres. All workflow state
(cursors, phase, event buffer) lives in Temporal's event-sourced history.

```
┌───────────────────────────────────────────────────────┐
│                    Temporal Server                     │
│                                                       │
│  Workflow History:                                     │
│    - cursors: { products: "prod_xyz", ... }           │
│    - phase: "live"                                    │
│    - event_buffer: [...]                              │
│    - config: { source_name: "stripe", ... }           │
│                                                       │
│  Search Attributes:                                   │
│    - AccountId: "acct_..."                            │
│    - WorkflowType: "SyncWorkflow"                     │
└───────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────┐
│                      PostgreSQL                       │
│                                                       │
│  Only synced data tables:                             │
│    - products (id, name, ...)                         │
│    - customers (id, email, ...)                       │
│    - etc.                                             │
│                                                       │
│  NO metadata: no migrations table, no _sync_runs,     │
│  no _managed_webhooks                                 │
└───────────────────────────────────────────────────────┘
```

### Crash recovery

On worker crash, Temporal replays the workflow from its event history.
All `@instance` variables are reconstructed deterministically. The
workflow resumes exactly where it left off — mid-backfill, mid-live, etc.

### History compaction

`continue_as_new` every 500 iterations carries forward only the current
state snapshot, shedding accumulated history events. This bounds memory
and replay time for long-running syncs.

---

## Data flow: backfill page

```
SyncWorkflow                  Activity              Stateless API
    │                            │                       │
    │  execute_activity          │                       │
    │  (BackfillPage)            │                       │
    │───────────────────────────▶│                       │
    │                            │  POST /read           │
    │                            │  X-Sync-Params: {...} │
    │                            │──────────────────────▶│
    │                            │                       │ source.read()
    │                            │                       │───▶ Stripe API
    │                            │                       │◀─── pages
    │                            │  NDJSON response      │
    │                            │◀──────────────────────│
    │                            │                       │
    │  { records, states, ... }  │                       │
    │◀───────────────────────────│                       │
    │                            │                       │
    │  execute_activity          │                       │
    │  (WriteBatch)              │                       │
    │───────────────────────────▶│                       │
    │                            │  POST /write          │
    │                            │  body: NDJSON records │
    │                            │──────────────────────▶│
    │                            │                       │ dest.write()
    │                            │                       │───▶ Postgres
    │                            │  NDJSON states        │
    │                            │◀──────────────────────│
    │  { states }                │                       │
    │◀───────────────────────────│                       │
    │                            │                       │
    │  @cursors[stream] = ...    │                       │
    │  (persisted in workflow    │                       │
    │   memory by Temporal)      │                       │
```

## Data flow: live event

```
Stripe ──webhook──▶ Webhook Bridge ──signal──▶ SyncWorkflow
                                                    │
                                              @event_buffer << event
                                                    │
                                              wait_for_events_or_timeout(60s)
                                                    │
                                              batch = buffer.shift(50)
                                                    │
                                    ┌───────────────┘
                                    ▼
                              ProcessEvent activity
                                    │
                         ┌──────────┴──────────┐
                         ▼                      ▼
                    POST /read             POST /write
                  (event → records)      (records → Postgres)
                         │                      │
                         ▼                      ▼
                    Stripe SDK           Postgres INSERT
                  (expand, validate)     (upsert rows)
```

---

## File map

```
temporal_ruby/
├── .ruby-version                   # Ruby 3.3.4
├── Gemfile                         # temporalio, faraday, rspec, pg, stripe
├── lib/
│   ├── worker.rb                   # Entry point: connect + register + poll
│   ├── webhook_bridge.rb           # WEBrick server: webhooks → signals
│   ├── workflows/
│   │   └── sync_workflow.rb        # Workflow: setup → backfill → live
│   └── activities/
│       └── sync_activities.rb      # 8 activity classes (HTTP → stateless API)
└── spec/
    ├── spec_helper.rb              # RSpec config
    ├── sync_workflow_spec.rb        # Unit: stubbed activities, local Temporal
    ├── e2e/
    │   └── sync_workflow_e2e_spec.rb  # E2E: real Stripe + Postgres
    └── support/
        └── start-api.mjs           # Helper: spawns stateless API for E2E
```

---

## Running

```sh
# Prerequisites
cd temporal_ruby && bundle install
cd .. && pnpm build    # build stateless API + connectors

# Start infrastructure
docker compose up -d   # Temporal server + Postgres

# Start worker
ENGINE_URL=http://localhost:3001 ruby lib/worker.rb

# Start webhook bridge (optional, for live events)
ruby lib/webhook_bridge.rb
```

## Testing

```sh
# Unit tests — no Docker, no external services
bundle exec rspec spec/sync_workflow_spec.rb

# E2E tests — needs Stripe key + Postgres + pnpm build
STRIPE_API_KEY=rk_test_... bundle exec rspec spec/e2e/
```
