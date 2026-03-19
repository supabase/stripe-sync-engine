# Architecture Documentation

This directory contains the architecture docs for the Stripe Sync ecosystem.

![4 layers of product in the Stripe Sync ecosystem](stripe-sync-layers.png)

## Layers

### Layer 1 · [`1-data-api/`](1-data-api/ARCHITECTURE.md) (out of scope)

How data gets out of Stripe — the APIs and primitives that sync engine sources consume. Today we have List APIs (paginated polling), webhooks (push with gaps), and Event Bridge (thin events requiring hydration). We want something more efficient — ideally a single ordered replayable stream. This is a separate effort but would slot in as a new source type under the existing sync engine protocol.

### Layer 2 · [`2-sync-engine/`](2-sync-engine/ARCHITECTURE.md)

The core engine: message protocol, Source/Destination interfaces, orchestrator, and state management. Source and destination agnostic — does not assume Stripe or Postgres.

- `ARCHITECTURE.md` — protocol spec, message types, orchestrator, state flow
- `sync-engine-types.ts` — type definitions (Stream, Message, State, etc.)
- `sync-engine-api.ts` — interfaces (Source, Destination, Transform, Orchestrator)
- `sync-engine-examples.sh` — Unix pipe composition examples

### Layer 3 · [`3-sync/`](3-sync/ARCHITECTURE.md)

The Stripe Sync product: Sync resources, source/destination configs, scheduling, and the `stripe sync` CLI. This is the API layer that wires sources to destinations and manages their lifecycle.

- `ARCHITECTURE.md` — Sync resource, source types, destination types, status lifecycle
- `sync-types.ts` — Sync, SourceConfig, DestinationConfig, SyncStatus
- `sync-api.ts` — API routes
- `sync-cli.md` — CLI help text

### Layer 4 · [`4-db/`](4-db/ARCHITECTURE.md)

The Stripe DB product: managed databases, access management, query API. A convenience layer built on top of Stripe Sync.

- `ARCHITECTURE.md` — database types, lifecycle, access methods, API surface
- `db-types.ts` — Database, DatabaseUser, PostgresConnection
- `db-api.ts` — API routes with SyncSummary enrichment
- `db-cli.md` — CLI help text

## How to read this

Start from the layer you care about:

- **Building a new source or destination?** Start with [`2-sync-engine/ARCHITECTURE.md`](2-sync-engine/ARCHITECTURE.md).
- **Configuring a sync pipeline?** Start with [`3-sync/ARCHITECTURE.md`](3-sync/ARCHITECTURE.md).
- **Working on the managed database product?** Start with [`4-db/ARCHITECTURE.md`](4-db/ARCHITECTURE.md).
