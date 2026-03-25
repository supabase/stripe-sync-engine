---
title: Temporal Workflow Architecture
---

# Temporal Workflow Architecture

When Temporal is enabled, sync lifecycle is managed by durable workflows instead of running in-process. The workflow orchestrates setup, continuous reconciliation, live event processing, and teardown.

Three servers run independently:

- **Webhook Server** — public-facing; receives raw Stripe events and signals the matching Temporal workflow(s)
- **Service API** — internal; config CRUD, credential management, config resolution
- **Engine API** — stateless sync execution (setup, sync, teardown via `X-Sync-Params`)

Activities call the service for config resolution, then the engine for execution.

## Architecture Overview

```mermaid
graph TD
    subgraph Stripe
        StripeAPI["Stripe API"]
        StripeWH["Stripe Webhooks"]
    end

    subgraph WebhookServer["Webhook Server (public)"]
        WHRoute["POST /webhooks/{cred_id}"]
    end

    subgraph Service["Sync Service (internal)"]
        CRUD["/syncs CRUD"]
        Resolve["GET /syncs/{id}<br/>?include_credentials=true"]
    end

    subgraph EngineAPI["Sync Engine"]
        ESetup["POST /setup"]
        ESync["POST /sync"]
        ETeardown["POST /teardown"]
    end

    subgraph Temporal["Temporal Server"]
        Workflow["syncWorkflow(syncId)"]
        Worker["Worker (activities)"]
    end

    subgraph Destinations
        Postgres["Postgres"]
        Sheets["Google Sheets"]
    end

    %% Stripe → Webhook Server → Temporal
    StripeWH --> WHRoute
    WHRoute -- "signal: stripe_event" --> Workflow

    %% Service → Workflow
    CRUD -- "start / signal: delete" --> Workflow

    %% Workflow → Activities
    Workflow --> Worker

    %% Activities → Service (resolve) → Engine (execute)
    Worker -- "1. resolve config" --> Resolve
    Worker -- "2. X-Sync-Params" --> ESetup
    Worker -- "2. X-Sync-Params" --> ESync
    Worker -- "2. X-Sync-Params" --> ETeardown

    %% Engine → external
    ESync -- "read" --> StripeAPI
    ESync -- "write" --> Postgres
    ESync -- "write" --> Sheets
```

## Activity Flow

Each activity makes two HTTP calls — one lightweight (resolve), one heavy (execute):

```mermaid
sequenceDiagram
    participant Workflow
    participant Activity
    participant Service as Sync Service
    participant Engine as Sync Engine
    participant Dest as Destination

    Workflow->>Activity: run(syncId)

    rect rgb(240, 248, 255)
        Note over Activity,Service: 1. Resolve config
        Activity->>Service: GET /syncs/{id}?include_credentials=true
        Service-->>Activity: SyncConfig with creds inline
        Note over Activity: Build X-Sync-Params<br/>(source_name, source_config,<br/>destination_name, destination_config,<br/>streams)
    end

    rect rgb(240, 255, 240)
        Note over Activity,Engine: 2. Execute sync
        Activity->>Engine: POST /sync<br/>X-Sync-Params: {...}
        Engine->>Engine: selectStateStore → load cursors
        Engine->>Engine: source.read (Stripe API)
        Engine->>Dest: destination.write
        Engine->>Engine: persist state checkpoints
        Engine-->>Activity: NDJSON stream
        Note over Activity: heartbeat every 50 msgs
    end

    Activity-->>Workflow: RunResult { errors }
```

## Webhook Event Flow

The webhook path crosses four boundaries (Stripe → Webhook Server → Temporal → Service → Engine):

```mermaid
sequenceDiagram
    participant Stripe
    participant Webhook as Webhook Server
    participant Workflow as syncWorkflow
    participant Activity
    participant Service as Sync Service
    participant Engine as Sync Engine

    Stripe->>Webhook: POST /webhooks/{credential_id}
    Note over Webhook: Scan syncs.json for<br/>matching credential_id
    Webhook->>Workflow: signal('stripe_event', event)
    Webhook-->>Stripe: 200 ok (fire-and-forget)
    Note over Workflow: Buffer event

    Note over Workflow: Next loop iteration

    Workflow->>Activity: run(syncId, [event1, event2, ...])
    Activity->>Service: GET /syncs/{id}?include_credentials=true
    Service-->>Activity: SyncConfig with creds
    Activity->>Engine: POST /sync<br/>X-Sync-Params + NDJSON body (events)
    Engine->>Engine: source processes events → destination writes
    Engine-->>Activity: NDJSON response stream
    Activity-->>Workflow: RunResult
```

## Backfill Flow

```mermaid
sequenceDiagram
    participant User
    participant Service as Sync Service
    participant Workflow as syncWorkflow
    participant Activity
    participant Engine as Sync Engine
    participant Dest as Destination

    User->>Service: POST /syncs (create)
    Service->>Workflow: start syncWorkflow(syncId)

    Workflow->>Activity: setup(syncId)
    Activity->>Service: GET /syncs/{id}?include_credentials=true
    Activity->>Engine: POST /setup (X-Sync-Params)
    Engine->>Dest: CREATE TABLE / ensure schema

    loop Reconciliation loop
        Workflow->>Activity: run(syncId)
        Activity->>Service: GET /syncs/{id}?include_credentials=true
        Activity->>Engine: POST /sync (X-Sync-Params)
        Engine->>Engine: load state → read source → write dest → persist state
        Engine-->>Activity: NDJSON stream (heartbeat every 50 msgs)
        Activity-->>Workflow: RunResult
        Note over Workflow: continueAsNew at 500 iterations
    end

    User->>Service: DELETE /syncs/{id}
    Service->>Workflow: signal('delete')

    Workflow->>Activity: teardown(syncId)
    Activity->>Service: GET /syncs/{id}?include_credentials=true
    Activity->>Engine: POST /teardown (X-Sync-Params)
    Engine->>Dest: DROP TABLE / cleanup
```

## Workflow State Machine

```mermaid
stateDiagram-v2
    [*] --> Setup: phase != 'running'
    [*] --> Loop: phase == 'running'<br/>(after continueAsNew)
    Setup --> Loop: setup(syncId)
    Setup --> Teardown: delete signal<br/>during setup

    state Loop {
        [*] --> CheckPause
        CheckPause --> Paused: paused == true
        Paused --> CheckPause: resume signal
        CheckPause --> DrainEvents: events buffered
        CheckPause --> Backfill: no events
        DrainEvents --> CheckIteration: run(syncId, events)
        Backfill --> CheckIteration: run(syncId)
        CheckIteration --> CheckPause: iteration < 500
        CheckIteration --> ContinueAsNew: iteration >= 500
    }

    Loop --> Teardown: delete signal
    Teardown --> [*]: teardown(syncId)
    ContinueAsNew --> [*]: continueAsNew(syncId, 'running')
```

## Key Design Decisions

### Why three servers?

Each server has a single, clearly scoped responsibility:

|             | Webhook Server                                      | Sync Service                                        | Sync Engine                                 |
| ----------- | --------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| **Purpose** | Public webhook ingress; fan out signals to Temporal | Config CRUD, credential management, config resolution | Stateless sync execution                    |
| **State**   | None — reads config store to locate matching syncs  | Stores configs, credentials                         | Manages cursor state via `selectStateStore` |
| **Routes**  | `POST /webhooks/{credential_id}`                    | `/syncs`, `/credentials`                            | `/setup`, `/sync`, `/teardown`              |
| **Exposure**| Public (Stripe POSTs here)                          | Internal                                            | Internal                                    |

The webhook server requires only a Temporal client and the config store (read-only) to fan out signals. It never touches credentials or runs connectors.

### Why activities resolve each time?

Activities call `GET /syncs/{id}?include_credentials=true` on every invocation rather than carrying config in the workflow. This means:

- Workflow stays `syncId`-only — lightweight `continueAsNew`
- Config changes via `PATCH /syncs/{id}` are picked up automatically
- No `updateConfigSignal` needed
- Credential refresh (if any) is always fresh
- The resolution call is milliseconds; the sync call is seconds to minutes

### State management

The engine handles state internally via `selectStateStore`:

1. Engine auto-detects a compatible state store package (`@stripe/sync-state-postgres` for postgres destinations)
2. `setupStateStore()` creates the `_sync_state` table if needed
3. Engine loads cursors on each run, persists checkpoints during sync
4. Activities and workflows never touch state

## Components

### Workflow (`temporal/workflows.ts`)

**Input:** `syncWorkflow(syncId: string, opts?: { phase?: string })`

**Signals:** `stripe_event`, `pause`, `resume`, `delete`

**Query:** `status` → `{ phase, paused, iteration }`

### Activities (`temporal/activities.ts`)

`createActivities({ serviceUrl, engineUrl })` returns three activities:

- **`setup(syncId)`** — resolve from service → `POST /setup` on engine
- **`run(syncId, input?)`** — resolve from service → `POST /sync` on engine (with optional NDJSON body for events)
- **`teardown(syncId)`** — resolve from service → `POST /teardown` on engine

### Worker (`temporal/worker.ts`)

Runs as a separate process via the CLI:

```sh
sync-service worker \
  --temporal-address localhost:7233 \
  --service-url http://localhost:4020 \
  --engine-url http://localhost:4010
```

## Running Locally

```sh
# Terminal 1: Temporal dev server
temporal server start-dev

# Terminal 2: Sync engine (stateless execution)
sync-engine serve --port 4010

# Terminal 3: Sync service (config CRUD + config resolution)
sync-service serve --port 4020 --temporal-address localhost:7233

# Terminal 4: Webhook server (public ingress)
sync-service webhook --port 4030 --temporal-address localhost:7233

# Terminal 5: Worker
sync-service worker --temporal-address localhost:7233
```

Create a sync — the workflow starts automatically:

```sh
# Create sync (via internal service API)
curl -X POST http://localhost:4020/syncs \
  -H 'Content-Type: application/json' \
  -d '{
    "source": { "type": "stripe", "api_key": "sk_test_..." },
    "destination": { "type": "postgres", "connection_string": "postgresql://..." },
    "streams": [{ "name": "products" }]
  }'

# Check workflow status
temporal workflow query --workflow-id sync_<id> --type status

# Pause/resume
curl -X POST http://localhost:4020/syncs/<id>/pause
curl -X POST http://localhost:4020/syncs/<id>/resume

# Delete (triggers teardown)
curl -X DELETE http://localhost:4020/syncs/<id>
```

Point Stripe's webhook dashboard at the **webhook server** (`http://your-host:4030/webhooks/{credential_id}`), not the service API.

## Testing

### Unit tests (stubbed activities)

`apps/service/src/__tests__/temporal-workflow.test.ts` — uses `@temporalio/testing` with stubbed activities:

- Setup → reconciliation → delete lifecycle
- Event processing via `stripe_event` signal
- Pause/resume
- Teardown on delete
- `continueAsNew` phase skip

### E2E tests (real Stripe + real destinations)

`e2e/temporal.test.ts` — starts both service + engine servers, uses `@temporalio/testing` with real Stripe API:

**Stripe → Postgres** (requires `STRIPE_API_KEY`):

1. Creates sync via service API
2. Backfills products from Stripe into Postgres
3. Updates a product via Stripe API, signals the event to the workflow
4. Verifies the live update landed in Postgres
5. Signals delete, verifies teardown (schema dropped)

**Stripe → Google Sheets** (requires `STRIPE_API_KEY` + Google OAuth creds):

1. Creates sync via service API
2. Backfills products into a Google Sheet tab
3. Verifies row count and data shape
4. Cleans up the test tab

## Files

| File                                                   | Role                                            |
| ------------------------------------------------------ | ----------------------------------------------- |
| `apps/service/src/api/webhook-app.ts`                  | `createWebhookApp` — standalone webhook ingress |
| `apps/service/src/temporal/types.ts`                   | `RunResult`, `SyncActivities`, `WorkflowStatus` |
| `apps/service/src/temporal/activities.ts`              | Resolve from service, execute on engine         |
| `apps/service/src/temporal/workflows.ts`               | Workflow: signals, queries, main loop           |
| `apps/service/src/temporal/worker.ts`                  | Worker factory                                  |
| `apps/service/src/cli/main.ts`                         | `serve`, `webhook`, `worker` subcommands        |
| `apps/service/src/__tests__/temporal-workflow.test.ts` | Unit tests                                      |
| `e2e/temporal.test.ts`                                 | E2E tests                                       |
