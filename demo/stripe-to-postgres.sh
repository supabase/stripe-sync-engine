#!/usr/bin/env bash
# Sync Stripe → Postgres via the sync-engine CLI.
#
# Usage:
#   ./demo/stripe-to-postgres.sh           # normal
#   ./demo/stripe-to-postgres.sh verbose   # debug logging with full request/response bodies
#
# Env: STRIPE_API_KEY, DATABASE_URL (or POSTGRES_URL)
# Override TypeScript runner: TS_RUNNER="bun" or TS_RUNNER="npx tsx"
set -euo pipefail
cd "$(dirname "$0")/.."
RUN="${TS_RUNNER:-node --import tsx}"
POSTGRES_URL="${DATABASE_URL:-${POSTGRES_URL:?Set DATABASE_URL or POSTGRES_URL}}"

if [[ "${1:-}" == "verbose" ]]; then
  export LOG_LEVEL=debug
fi

echo "=== Stripe → Postgres ===" >&2
echo "Postgres: $POSTGRES_URL" >&2


# ── Option A: Simple shorthand (new sync command) ────────────────────────────
$RUN apps/engine/src/bin/sync-engine.ts sync \
  --stripe-api-key "$STRIPE_API_KEY" \
  --postgres-url "$POSTGRES_URL" \
  --streams products,prices,customers \
  --backfill-limit 10

# ── Option B: Full JSON pipeline (equivalent) ────────────────────────────────
# PIPELINE=$(node -e "console.log(JSON.stringify({
#   source: { type: 'stripe', stripe: { api_key: process.env.STRIPE_API_KEY, backfill_limit: 10 } },
#   destination: { type: 'postgres', postgres: { url: '$POSTGRES_URL', schema: 'public', port: 5432, batch_size: 100 } },
#   streams: [{ name: 'products' }, { name: 'prices' }, { name: 'customers' }],
# }))")
# $RUN apps/engine/src/bin/sync-engine.ts pipeline-sync --xPipeline "$PIPELINE"
