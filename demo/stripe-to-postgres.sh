#!/usr/bin/env bash
# Sync Stripe → Postgres via the sync-engine CLI.
#
# Env: STRIPE_API_KEY, DATABASE_URL
# Override TypeScript runner: TS_RUNNER="bun" or TS_RUNNER="node --import tsx"
set -euo pipefail
cd "$(dirname "$0")/.."
RUN="${TS_RUNNER:-$(dirname "$0")/../scripts/ts-run}"

ACCT=$(curl -su "$STRIPE_API_KEY:" https://api.stripe.com/v1/account 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
echo "Stripe: $ACCT" >&2
echo "Postgres: $DATABASE_URL" >&2

$RUN apps/sync-engine/src/cli.ts sync \
  --stripe-api-key "$STRIPE_API_KEY" \
  --postgres-url "$DATABASE_URL" \
  --streams products \
  --backfill-limit 10 \
  --no-state
