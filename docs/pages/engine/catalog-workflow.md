# Catalog Workflow: Discover → Configure → Sync

How a sync gets set up, from discovering available streams to running the first sync.

## Overview

```
┌────────┐   discover()   ┌─────────┐   user selects   ┌────────────────────┐
│ Source  │ ─────────────→ │ Catalog │ ───────────────→  │ Configured Catalog │
└────────┘                 └─────────┘    & configures   └────────────────────┘
                                                                  │
                                          ┌───────────────────────┤
                                          ▼                       ▼
                                    source.read()          destination.setup()
                                    source.setup()         destination.write()
```

## Step 1: Discover

The source connector inspects the upstream system and returns a **Catalog** — the full list of streams available to sync.

```
source.discover({ config }) → CatalogMessage
```

```json
{
  "type": "catalog",
  "streams": [
    {
      "name": "customers",
      "primary_key": [["id"]],
      "json_schema": { "type": "object", "properties": { "id": { "type": "string" }, "email": { "type": "string" }, ... } }
    },
    {
      "name": "products",
      "primary_key": [["id"]],
      "json_schema": { "type": "object", "properties": { "id": { "type": "string" }, "name": { "type": "string" }, ... } }
    },
    {
      "name": "invoices",
      "primary_key": [["id"]],
      "json_schema": { ... }
    },
    ...
  ]
}
```

Each **Stream** has:

| Field          | Description                                                        |
| -------------- | ------------------------------------------------------------------ |
| `name`         | Table/resource name (e.g. `customers`, `invoices`)                 |
| `primary_key`  | Paths to fields that uniquely identify a record (e.g. `[["id"]]`) |
| `json_schema`  | JSON Schema describing the record shape (from OpenAPI or runtime)  |
| `metadata`     | Source-specific context (e.g. `api_version`, `account_id`)         |

For the Stripe source, `discover()` walks the OpenAPI spec and the resource registry to produce one stream per syncable Stripe resource.

## Step 2: Configure (UI / CLI)

The user (or application) selects which streams to sync and how. This is where **selective sync** happens — you don't have to sync everything.

For each selected stream, the user decides:

| Setting                  | Options                                       | Description                                |
| ------------------------ | --------------------------------------------- | ------------------------------------------ |
| `sync_mode`              | `full_refresh` · `incremental`                | Pull everything each time, or only changes |
| `destination_sync_mode`  | `append` · `overwrite` · `append_dedup`       | How records land in the destination        |
| `cursor_field`           | field path (optional)                          | Which field tracks changes for incremental |

This produces a **Configured Stream** — the original stream data plus the user's sync settings:

```json
{
  "stream": {
    "name": "customers",
    "primary_key": [["id"]],
    "json_schema": { ... },
    "metadata": { "api_version": "2025-04-30.basil" }
  },
  "sync_mode": "incremental",
  "destination_sync_mode": "append_dedup",
  "cursor_field": ["updated"]
}
```

The array of all configured streams forms the **Configured Catalog**:

```json
{
  "streams": [
    { "stream": { "name": "customers", ... }, "sync_mode": "incremental", "destination_sync_mode": "append_dedup" },
    { "stream": { "name": "products", ... }, "sync_mode": "full_refresh", "destination_sync_mode": "overwrite" }
  ]
}
```

Streams the user didn't select are simply absent — the engine never touches them.

## Step 3: Setup

Before the first sync, both source and destination receive the configured catalog for resource provisioning:

```
source.setup({ config, catalog })        → creates webhook endpoints, replication slots, etc.
destination.setup({ config, catalog })    → creates schemas, tables, indexes
```

The destination uses the configured catalog to know:
- Which tables to create (from `stream.name`)
- What columns each table has (from `stream.json_schema`)
- What primary key to use (from `stream.primary_key`)
- How to handle writes (from `destination_sync_mode`)

## Step 4: Sync

The engine passes the configured catalog to both `read()` and `write()`:

```
source.read({ config, catalog, state })
  → AsyncIterable<Message>  (records, state checkpoints, status updates)
    → destination.write({ config, catalog }, $stdin)
      → AsyncIterable<DestinationOutput>  (state confirmations, errors)
```

The catalog flows through the entire pipeline so each component knows which streams are active and how they're configured.

## Full Sequence

```
 User / App              Engine               Source              Destination
     │                     │                     │                     │
     │  "create sync"      │                     │                     │
     │────────────────────→│                     │                     │
     │                     │   discover(config)  │                     │
     │                     │────────────────────→│                     │
     │                     │   CatalogMessage    │                     │
     │                     │←────────────────────│                     │
     │                     │                     │                     │
     │   present streams   │                     │                     │
     │←────────────────────│                     │                     │
     │                     │                     │                     │
     │   select & configure│                     │                     │
     │   streams           │                     │                     │
     │────────────────────→│                     │                     │
     │                     │                     │                     │
     │                     │  ConfiguredCatalog  │                     │
     │                     │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ →│
     │                     │                     │  setup(catalog)     │
     │                     │────────────────────→│                     │
     │                     │                     │                     │
     │                     │                     │  setup(catalog)     │
     │                     │─────────────────────────────────────────→│
     │                     │                     │                     │
     │                     │                     │    creates tables,  │
     │                     │                     │    indexes, etc.    │
     │                     │                     │                     │
     │                     │  read(catalog, state)                     │
     │                     │────────────────────→│                     │
     │                     │   records ──────────│────────────────────→│
     │                     │                     │  write(catalog, $stdin)
     │                     │   state ←───────────│────────────────────│
     │                     │                     │                     │
     │   sync running      │                     │                     │
     │←────────────────────│                     │                     │
```

## Data Types Reference

```
Catalog (from discover)
  └─ streams: Stream[]
       ├─ name: string                    "customers"
       ├─ primary_key: string[][]         [["id"]]
       ├─ json_schema?: object            { type: "object", properties: { ... } }
       └─ metadata?: object               { api_version: "2025-04-30.basil" }

ConfiguredCatalog (from user selection)
  └─ streams: ConfiguredStream[]
       ├─ stream: Stream                  (from discover, unchanged)
       ├─ sync_mode: string               "full_refresh" | "incremental"
       ├─ destination_sync_mode: string   "append" | "overwrite" | "append_dedup"
       ├─ cursor_field?: string[]         ["updated"]
       └─ system_columns?: object[]       [{ name: "_account_id", type: "text", index: true }]
```

The key insight: `Stream` is what the source **offers**, `ConfiguredStream` is what the user **chose**, and `ConfiguredCatalog` is the contract the destination **implements**.
