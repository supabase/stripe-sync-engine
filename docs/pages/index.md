---
title: Stripe Sync Engine
---

# Stripe Sync Engine

Sync your Stripe data to PostgreSQL — backfill historical objects, then keep them
up to date with live events via webhooks or WebSocket.

## Features

- **Full backfill** — paginate through Stripe list APIs and upsert into Postgres
- **Live sync** — receive events via webhook server or WebSocket and apply changes in real time
- **Resumable** — cursor-based state tracking lets you stop and restart without re-syncing
- **Schema projection** — automatically creates and evolves Postgres tables from Stripe's OpenAPI spec
- **Pluggable** — source and destination are separate connectors; Postgres is the default destination

## Quick start

```sh
npx @stripe/sync-engine sync \
  --stripe-api-key sk_live_... \
  --database-url postgresql://localhost:5432/mydb \
  --schema stripe
```

## Slides

- [Architecture overview](/slides/architecture/)
- [Protocol demo — live coding](/slides/demo/)

## Links

- [GitHub](https://github.com/stripe/sync-engine)
- [npm](https://www.npmjs.com/package/@stripe/sync-engine)

---

> **Note:** This site is temporarily hosted at
> [stripe-sync-engine-pages.vercel.app](https://stripe-sync-engine-pages.vercel.app/).
> A proper custom domain will be set up later.
