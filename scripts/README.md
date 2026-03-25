# Scripts

Demo and utility scripts. Scripts run TypeScript source directly via `npx tsx` — no build step required (`pnpm install` is enough).

### TypeScript runner

Scripts default to `npx tsx`. Override with the `TS_RUNNER` env var:

```sh
TS_RUNNER="bun" ./scripts/read-from-stripe.sh
TS_RUNNER="node --import tsx" ./scripts/read-from-stripe.sh
```

Why not `node --strip-types`? Node refuses to strip types for files inside `node_modules/`, which includes pnpm workspace symlinks — so workspace packages stay broken even with the flag enabled.

## Connector demos

These invoke source/destination connector CLIs directly — no engine in between.

| Script                 | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `read-from-stripe.sh`  | Read products from Stripe, emit NDJSON to stdout     |
| `write-to-sheets.sh`   | Write NDJSON to Google Sheets (stdin or sample data) |
| `write-to-postgres.sh` | Write NDJSON to Postgres (stdin or sample data)      |

Pipe them together:

```sh
./scripts/read-from-stripe.sh | ./scripts/write-to-sheets.sh
./scripts/read-from-stripe.sh | ./scripts/write-to-postgres.sh
```

## Full sync (via engine CLI)

These use the sync-engine CLI which handles discover → read → write in one shot.

| Script                       | Description                           |
| ---------------------------- | ------------------------------------- |
| `stripe-to-postgres.sh`      | Sync Stripe products to Postgres      |
| `stripe-to-google-sheets.sh` | Sync Stripe products to Google Sheets |

## Utilities

| Script               | Description                                      |
| -------------------- | ------------------------------------------------ |
| `reset-postgres.sh`      | Drop all non-system schemas and tables in public        |
| `publish-packages.sh`    | Publish all non-private packages to `$STRIPE_NPM_REGISTRY` |
| `d2.mjs`                 | Render D2 diagrams to SVG                               |

## Environment variables

Set in `.envrc` (via direnv):

| Variable                | Used by                                         |
| ----------------------- | ----------------------------------------------- |
| `STRIPE_API_KEY`        | Stripe scripts                                  |
| `DATABASE_URL`          | Postgres scripts                                |
| `GOOGLE_CLIENT_ID`      | Sheets scripts                                  |
| `GOOGLE_CLIENT_SECRET`  | Sheets scripts                                  |
| `GOOGLE_REFRESH_TOKEN`  | Sheets scripts                                  |
| `GOOGLE_SPREADSHEET_ID` | Sheets scripts                                  |
| `TS_RUNNER`             | Override TypeScript runner (default: `npx tsx`) |
