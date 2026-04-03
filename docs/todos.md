
# Todos


* ❯ make sure we are able to get control messages to actually result in updates the config store


Short-term actionable items. Move to a dated plan in `docs/plans/` when scoped.

## Now

- Land grouped Stripe tables in stream selector (`docs/plans/2026-04-03-grouped-tables.md`)

## Soon

- CLI backfill progress display (`2026-03-20-plan-005-cli-progress-display`) — progress bars with row counts
- Scope rename: `@stripe/` → `@stripe-sync/` (`2026-03-20-plan-008-scope-rename-stripe-sync`) — blocked on npm org approval
- Move openapi fully into `source-stripe` (`2026-03-18-plan-002-move-openapi-to-source-stripe`) — `packages/openapi` is now pure but still separate

## Connectors

- Selective sync — UI/API for choosing specific streams per pipeline
- Selective backfill — backfill only a subset of streams
- Better rate limiting (distributed, per-account, across workers)

## Supabase

- End-to-end Supabase test: install, backfill, check status, verify live event, uninstall
- Status reporting in Supabase UI (parse sync state for progress display)
- Remove `esbuild`/`?raw` bundling — use `npm:` specifier imports now that packages are published
- Secret store integration

## Destination Postgres

- Indexes and RLS in destination schema
- Schema customization for non-Stripe data

## Service / Auth

- HTTP CONNECT proxy support (e.g. Smokescreen via egress-proxy-srv)
- OAuth credential refresh workflow (auto-renew expiring tokens)
- Global state (per-pipeline state in addition to per-stream cursors)
- Fan-in support (multiple sources → one destination)

## Developer Experience

- Source/destination test ergonomics for connector authors
- Replit integration (skills file, package ergonomics)


- https://tasknotes.dev/features/inline-tasks/