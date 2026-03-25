#!/usr/bin/env bash
# Read from Stripe via the connector CLI — outputs NDJSON to stdout.
#
# Usage:
#   ./scripts/read-from-stripe.sh
#   ./scripts/read-from-stripe.sh | ./scripts/write-to-sheets.sh
#
# Env: STRIPE_API_KEY
# Override TypeScript runner: TS_RUNNER="bun" or TS_RUNNER="node --import tsx"
set -euo pipefail
cd "$(dirname "$0")/.."
RUN="${TS_RUNNER:-$(dirname "$0")/../scripts/ts-run}"

ACCT=$(curl -su "$STRIPE_API_KEY:" https://api.stripe.com/v1/account 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
echo "Stripe: $ACCT" >&2

$RUN packages/source-stripe/src/bin.ts read \
  --config "{\"api_key\": \"$STRIPE_API_KEY\", \"backfill_limit\": 10}" \
  --catalog '{"streams":[{"stream":{"name":"products","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'
