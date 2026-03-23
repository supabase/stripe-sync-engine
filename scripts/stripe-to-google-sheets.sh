#!/usr/bin/env bash
# Sync Stripe → Google Sheets via the sync-engine CLI.
#
# Env: STRIPE_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_SPREADSHEET_ID
set -euo pipefail
cd "$(dirname "$0")/.."

ACCT=$(curl -su "$STRIPE_API_KEY:" https://api.stripe.com/v1/account 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
echo "Stripe: $ACCT" >&2
echo "Sheet: https://docs.google.com/spreadsheets/d/$GOOGLE_SPREADSHEET_ID" >&2

pnpm --filter @stripe/sync-engine exec node dist/cli.js \
  --stripe-api-key "$STRIPE_API_KEY" \
  --destination google-sheets \
  --destination-config "{
    \"client_id\": \"$GOOGLE_CLIENT_ID\",
    \"client_secret\": \"$GOOGLE_CLIENT_SECRET\",
    \"access_token\": \"unused\",
    \"refresh_token\": \"$GOOGLE_REFRESH_TOKEN\",
    \"spreadsheet_id\": \"$GOOGLE_SPREADSHEET_ID\"
  }" \
  --streams products \
  --backfill-limit 10 \
  --no-state
