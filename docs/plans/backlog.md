# Backlog

Actionable items not yet assigned to a plan. Migrate items to numbered plans when scoped.

## High priority

- HTTP CONNECT proxy support (e.g. stripe/smokescreen via egress-proxy-srv)
- OAuth credential refreshing workflow
- Global state (in addition to per-stream state)
- Fan-in support (multiple sources into one destination)

## Connectors

- Selective sync (choose specific streams/objects)
- Selective backfill (backfill only certain streams)
- Better rate limiting
- One webhook serving multiple stripe sources

## Supabase

- End-to-end Supabase test: install, backfill, check status, update, verify live event, uninstall
- Status reporting in Supabase UI (parsing sync state)
- Remove esbuild/`?raw` bundling — use `npm:` specifier imports now that packages are published
- Secret store integration for Supabase

## Destination Postgres

- Support indexes and RLS in destination-postgres
- Schema for non-Stripe data (custom schemas)

## Testing

- Source-test / destination-test ergonomics for connector authors
- Stateless CLI end-to-end test (backfill, update, verify live event)

## Developer experience

- Replit integration (skills file, package ergonomics)
