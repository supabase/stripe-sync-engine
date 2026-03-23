#!/usr/bin/env bash
# Pipe NDJSON records into Google Sheets via the connector CLI.
#
# Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_SPREADSHEET_ID
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Sheet: https://docs.google.com/spreadsheets/d/$GOOGLE_SPREADSHEET_ID" >&2

printf '%s\n' \
  '{"type":"record","stream":"demo","data":{"id":"1","name":"Alice","email":"alice@example.com"},"emitted_at":0}' \
  '{"type":"record","stream":"demo","data":{"id":"2","name":"Bob","email":"bob@example.com"},"emitted_at":0}' \
| node packages/destination-google-sheets/dist/bin.js write \
  --config "{
    \"client_id\": \"$GOOGLE_CLIENT_ID\",
    \"client_secret\": \"$GOOGLE_CLIENT_SECRET\",
    \"access_token\": \"unused\",
    \"refresh_token\": \"$GOOGLE_REFRESH_TOKEN\",
    \"spreadsheet_id\": \"$GOOGLE_SPREADSHEET_ID\"
  }" \
  --catalog '{"streams":[]}'
