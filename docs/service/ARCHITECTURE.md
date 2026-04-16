# Stripe Sync

Stripe Sync lets merchants create **sync pipelines** that continuously move data from a source system into a destination.

## System layers

```
StatefulSync (credential management + state persistence + scheduling)
  └── Engine (wires source → destination, persists state)
        ├── Source (reads upstream data)
        └── Destination (writes downstream data)
```

- **StatefulSync** — the stateful layer. Manages the four stores (credentials, config, state, logs), resolves stored config into engine-ready `SyncParams`, and calls the engine. Exposed via `apps/stateful` (REST API + CLI).

- **Engine** — the runtime that pipes a source to a destination. Filters messages (only data messages reach the destination), persists committed state checkpoints, handles errors, and routes logs. See [`../engine/ARCHITECTURE.md`](../engine/ARCHITECTURE.md).

- **Source / Destination** — the actual implementations that read from or write to external systems. Defined by the sync engine protocol in `packages/protocol`.

## Core Model

A **Sync** (aka sync pipeline) connects a **source** to a **destination**. Both may reference a **credential** for authentication.

- **SourceConfig** — where data comes from (e.g. Stripe API)
- **DestinationConfig** — where data lands (e.g. Postgres, Google Sheets)
- **Credential** — stored connection secrets (API keys, database passwords, OAuth tokens)

## Why "source" and not just "Stripe"?

The source isn't always Stripe. Other data providers may have their own source implementations. Keeping source as a first-class concept means the same pipeline model works for all of them.

## Source credentials

A Stripe organization may want to sync from a specific Stripe account. The source needs a credential (API key) to authenticate. Third-party sources will always need a user-supplied credential.

## Files

| File                                | Description                                                  |
| ----------------------------------- | ------------------------------------------------------------ |
| `packages/protocol/src/protocol.ts` | TypeScript interfaces for Source, Destination; message types |
| `apps/engine/src/lib/engine.ts`     | `createEngine()` — engine factory                            |
| `apps/service/src/lib/service.ts`   | `StatefulSync` class — the composition root                  |
| `apps/service/src/lib/stores.ts`    | Store interfaces: CredentialStore, StateStore, LogSink       |
| `apps/service/src/api/app.ts`       | Service HTTP API                                             |
| `apps/service/src/cli/index.ts`     | Service CLI entrypoint                                       |
