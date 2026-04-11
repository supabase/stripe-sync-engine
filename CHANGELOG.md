# Changelog

## v0.2.0 (2026-04-11)

### Features
- Auto-publish packages to npmjs.org on version bump (#272)
- Add `--live` CLI flag and `?only` setup/teardown filter (#271)
- Add multi-key sync support (#211)
- Add `sync` CLI shorthand for Stripe-to-Postgres (#267)
- Google Sheets native upsert and hostname in health endpoint (#266)
- Trace-level logging, per-stream record counts (#265)
- Parallelize and batch Postgres DDL for pipeline setup (#260)
- Verbose query/request logging (#258)
- Google Sheets workflow with 3 parallel loops and generic read activity (#253)
- Pipeline lifecycle state machine and workflow cleanup (#251)
- Eliminate `dist/` dependency during development via customConditions (#252)
- Pipeline state machine, SourceState schema, protocol + service refactors (#250)
- Typed control messages, full config replacement, SourceInput envelope (#248)
- FS pipeline store + ID-only workflows (#244)
- Everything-is-a-stream protocol redesign (#242)
- Google Sheets destination connector + row-index workflow (#237)
- Zod `.describe()` for OpenAPI field descriptions (#235)
- EOF terminal message + `state_limit`/`time_limit` query params (#234)
- Typed connector schemas in OpenAPI spec with OAS 3.1 validation (#230)
- Dashboard with openapi-fetch for typed API clients (#227)
- Visualizer deployed to docs site (#225)
- Dashboard, service Docker, webhooks, compact backfill state (#221)
- Publish Stripe API specs to Vercel CDN (stripe-sync.dev) (#214)
- Destination column filtering (#216)
- `POST /internal/query` endpoint (#213)
- Multi-arch Docker images (amd64 + arm64) (#212)
- CA bundle support for SSL verify-ca / verify-full (#209)
- Parallel sync and rate limiting (#194)
- Bundle latest Stripe OpenAPI spec as filesystem fallback (#207)
- Proxy Stripe SDK requests in source-stripe (#181)
- Proxy Postgres connections through HTTP CONNECT (#179)
- Dynamic resources and functions (#172)
- Metadata table extraction and schema editor preview (#142)
- X-State-Checkpoint-Limit header for page-at-a-time sync
- Pino structured logging replacing console calls
- Connector configs exposed as typed OpenAPI entities
- Webhook fan-out: one endpoint, multiple syncs
- Postgres-backed token bucket rate limiter
- AWS RDS IAM authentication for destination-postgres
- Temporal workflow support (TypeScript and Ruby)
- Supabase edge function consolidation (#176)
- Non-default sync schema names (#141)

### Bug Fixes
- Fix `/internal/query` error handling (#256)
- Strip deprecated paths from OpenAPI specs (#264)
- Require Stripe-Version header, skip unavailable endpoints (#262)
- Fix `emitted_at` from Unix ms integer to ISO 8601 string (#231)
- Respect `sslmode` from Postgres connection string (#191)
- Fix Deno-incompatible Stripe webhook payload handling (#150)
- Isolate per-object Stripe permission errors during sync initialization (#149)
- Fix constructed webhook URL was invalid (#146)
- Skip `invoice.upcoming` webhook to prevent NOT NULL violation (#103)
- Fix paging for backfilling historical data (#92)
- Skip unsupported webhook objects during live sync (#156)

### Breaking Changes
- Rename `@stripe/sync-protocol` to `@stripe/protocol`; pipeline stages moved to engine
- Rename `syncs` to `pipelines` throughout the service API
- Rename `SyncParams` to `PipelineConfig`
- Rename connector `data` field to `items` (#241)
- Snake_case interface for engine API + `/meta/*` endpoints (#233)
- Protocol cleanup: `timeLimitMs` renamed to `timeLimit`, nested configs, typed `pipeline_read` (#247)
- `api_version` is now required in `StripeClientConfig` (#258)
- `emitted_at` changed from Unix ms integer to ISO 8601 string (#231)
- Rename `X-Sync-Params` header to `X-Pipeline` with separate `X-State` header
All notable changes to sync-engine will be documented in this file.
