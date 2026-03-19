# Stripe Sync

Stripe Sync lets merchants create **sync pipelines** that continuously move data from a source system into a destination.

## System layers

```
Sync Service (API + scheduling + credential management)
  └── Orchestrator (wires source → destination, persists state)
        ├── Source (reads upstream data)
        └── Destination (writes downstream data)
```

- **Sync Service** — the user-facing layer. Exposes the REST API (`POST /syncs`, `POST /credentials`), the CLI (`stripe sync`), and the dashboard. Manages CRUD for configs and credentials, scheduling, and invokes the orchestrator when a sync needs to run.

- **Orchestrator** — the runtime that pipes a source to a destination. Filters messages (only data messages reach the destination), persists committed state checkpoints, handles errors, and routes logs. See [`../2-sync-engine/ARCHITECTURE.md`](../2-sync-engine/ARCHITECTURE.md).

- **Source / Destination** — the actual implementations that read from or write to external systems. Defined by the sync engine protocol.

## Core Model

A **Sync** (aka sync pipeline) connects a **source** to a **destination**. Both may reference a **credential** for authentication.

- **SourceConfig** — where data comes from (e.g. Stripe API Core, EventBridge)
- **DestinationConfig** — where data lands (e.g. Postgres, Google Sheets, Stripe Database)
- **Credential** — stored connection secrets (API keys, database passwords, OAuth tokens)

## Why "source" and not just "Stripe"?

The source isn't always Stripe. Other data providers may have their own source implementations. Keeping source as a first-class concept means the same pipeline model works for all of them.

## Source credentials

A Stripe organization may want to sync from a specific Stripe account. For first-party Stripe sources we can provision a system key internally, so a user-supplied credential may not be required. Third-party sources will always need a credential.

## Open questions

- **Naming:** "source" may be confusing when the source is almost always Stripe from the user's perspective. "dataSource" was suggested as an alternative.
- **CLI verbosity:** The nested `-d "source[type]=..."` flag syntax is verbose. Consider whether flattened flags or interactive prompts would be better for common cases.

## Files

| File               | Description                                                |
| ------------------ | ---------------------------------------------------------- |
| `sync-types.ts`    | TypeScript types for Credential, Sync, Source, Destination |
| `sync-api.ts`      | API route map (REST endpoints)                             |
| `sync-examples.ts` | Example objects with `satisfies` type checking             |
| `sync-cli.md`      | CLI help text in Stripe CLI format                         |
| `entities.d2`      | Entity relationship diagram (D2 source)                    |
| `entities.svg`     | Rendered entity diagram                                    |
