#!/usr/bin/env bash
# Write NDJSON records to Google Sheets via the connector CLI.
# Reads from stdin, or uses sample data if stdin is a terminal.
#
# Usage:
#   ./scripts/write-to-sheets.sh                              # sample data
#   ./scripts/read-from-stripe.sh | ./scripts/write-to-sheets.sh  # piped
#
# Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_SPREADSHEET_ID
# Override TypeScript runner: TS_RUNNER="bun" or TS_RUNNER="node --import tsx"
set -euo pipefail
cd "$(dirname "$0")/.."
RUN="${TS_RUNNER:-npx tsx}"

echo "Sheet: https://docs.google.com/spreadsheets/d/$GOOGLE_SPREADSHEET_ID" >&2

CONFIG="{
  \"client_id\": \"$GOOGLE_CLIENT_ID\",
  \"client_secret\": \"$GOOGLE_CLIENT_SECRET\",
  \"access_token\": \"unused\",
  \"refresh_token\": \"$GOOGLE_REFRESH_TOKEN\",
  \"spreadsheet_id\": \"$GOOGLE_SPREADSHEET_ID\"
}"

if [ -t 0 ]; then
  # No pipe — use sample data
  printf '%s\n' \
    '{"type":"record","stream":"demo","data":{"id":"1","name":"Alice","email":"alice@example.com"},"emitted_at":0}' \
    '{"type":"record","stream":"demo","data":{"id":"2","name":"Bob","email":"bob@example.com"},"emitted_at":0}' \
  | $RUN packages/destination-google-sheets/src/bin.ts write \
    --config "$CONFIG" --catalog '{"streams":[]}'
else
  # Piped — read from stdin
  $RUN packages/destination-google-sheets/src/bin.ts write \
    --config "$CONFIG" --catalog '{"streams":[]}'
fi
