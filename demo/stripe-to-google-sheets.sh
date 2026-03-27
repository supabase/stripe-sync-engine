#!/usr/bin/env bash
# Sync Stripe → Google Sheets via the sync-engine CLI.
#
# Env: STRIPE_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_SPREADSHEET_ID
# Override TypeScript runner: TS_RUNNER="bun" or TS_RUNNER="node --import tsx"
set -euo pipefail
cd "$(dirname "$0")/.."
RUN="${TS_RUNNER:-$(dirname "$0")/../scripts/ts-run}"

ACCT=$(curl -su "$STRIPE_API_KEY:" https://api.stripe.com/v1/account 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
echo "Stripe: $ACCT" >&2
echo "Sheet: https://docs.google.com/spreadsheets/d/$GOOGLE_SPREADSHEET_ID" >&2

PIPELINE=$(node -e "console.log(JSON.stringify({
  source: { name: 'stripe', api_key: process.env.STRIPE_API_KEY, backfill_limit: 10 },
  destination: {
    name: 'google-sheets',
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    access_token: 'unused',
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    spreadsheet_id: process.env.GOOGLE_SPREADSHEET_ID,
  },
  streams: [{ name: 'products' }],
}))")

$RUN apps/engine/src/cli/index.ts sync --xPipeline "$PIPELINE"
