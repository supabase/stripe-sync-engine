#!/usr/bin/env bash
# Sync Stripe → Postgres with live WebSocket streaming.
#
# After the initial backfill, the engine keeps running and streams live events
# via Stripe's WebSocket API (same mechanism as `stripe listen`). Any changes
# you make in the Stripe Dashboard (or via the API) appear in Postgres within
# seconds.
#
# Usage:
#   ./demo/stripe-to-postgres-live.sh
#
# Trigger test events (in another terminal):
#   stripe trigger customer.created
#   stripe trigger product.created
#   stripe trigger price.created
#
# Env: STRIPE_API_KEY, DATABASE_URL (or POSTGRES_URL)
# Override TypeScript runner: TS_RUNNER="bun" or TS_RUNNER="npx tsx"
set -euo pipefail
cd "$(dirname "$0")/.."
RUN="${TS_RUNNER:-node --import tsx}"
POSTGRES_URL="${DATABASE_URL:-${POSTGRES_URL:?Set DATABASE_URL or POSTGRES_URL}}"

echo "=== Stripe → Postgres (live WebSocket mode) ===" >&2
echo "Postgres: $POSTGRES_URL" >&2
echo "" >&2
echo "After backfill completes, the engine will keep running and stream" >&2
echo "live events. Press Ctrl+C to stop." >&2
echo "" >&2

$RUN apps/engine/src/cli/index.ts sync \
  --stripe-api-key "$STRIPE_API_KEY" \
  --postgres-url "$POSTGRES_URL" \
  --streams products,prices,customers \
  --backfill-limit 10 \
  --live
