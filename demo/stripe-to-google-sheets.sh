#!/usr/bin/env bash
# Sync Stripe → Google Sheets via the sync-engine CLI.
#
# Usage:
#   ./demo/stripe-to-google-sheets.sh
#
# Env: STRIPE_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
# Optional: GOOGLE_SPREADSHEET_ID (creates new sheet if omitted)
# Override TypeScript runner: TS_RUNNER="bun" or TS_RUNNER="npx tsx"
set -euo pipefail
cd "$(dirname "$0")/.."
RUN="${TS_RUNNER:-node --import tsx}"

echo "=== Stripe → Google Sheets ===" >&2
[ -n "${GOOGLE_SPREADSHEET_ID:-}" ] && echo "Sheet: https://docs.google.com/spreadsheets/d/$GOOGLE_SPREADSHEET_ID" >&2

PIPELINE=$(node -e "console.log(JSON.stringify({
  source: {
    type: 'stripe',
    stripe: {
      api_key: process.env.STRIPE_API_KEY,
      backfill_limit: 10,
    },
  },
  destination: {
    type: 'google_sheets',
    google_sheets: {
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      access_token: 'unused',
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      spreadsheet_id: process.env.GOOGLE_SPREADSHEET_ID || undefined,
      spreadsheet_title: 'Stripe Sync Demo',
      batch_size: 50,
    },
  },
  streams: [{ name: 'product' }, { name: 'customer' }],
}))")

$RUN apps/engine/src/bin/sync-engine.ts pipeline-sync --xPipeline "$PIPELINE"
