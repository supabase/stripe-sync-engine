#!/usr/bin/env bash
# destination-google-sheets2 examples
#
# Prerequisites:
#   pnpm install
#   direnv allow   # loads .envrc with GOOGLE_* vars
#
# All commands run from the monorepo root.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if command -v bun &>/dev/null; then
  TS="bun"
else
  TS="npx tsx"
fi

dest_sheets="$TS $ROOT/scripts/ts-cli.ts $ROOT/packages/destination-google-sheets2/src/index.ts"

# ── Config ────────────────────────────────────────────────────────

: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID}"
: "${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET}"
: "${GOOGLE_REFRESH_TOKEN:?Set GOOGLE_REFRESH_TOKEN}"
: "${GOOGLE_SPREADSHEET_ID:?Set GOOGLE_SPREADSHEET_ID}"

# Get a fresh access token from the refresh token
GOOGLE_ACCESS_TOKEN=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d client_id="$GOOGLE_CLIENT_ID" \
  -d client_secret="$GOOGLE_CLIENT_SECRET" \
  -d refresh_token="$GOOGLE_REFRESH_TOKEN" \
  -d grant_type=refresh_token | jq -r .access_token)

CONFIG=$(jq -cn \
  --arg cid "$GOOGLE_CLIENT_ID" \
  --arg cs "$GOOGLE_CLIENT_SECRET" \
  --arg at "$GOOGLE_ACCESS_TOKEN" \
  --arg rt "$GOOGLE_REFRESH_TOKEN" \
  --arg sid "$GOOGLE_SPREADSHEET_ID" \
  '{client_id: $cid, client_secret: $cs, access_token: $at, refresh_token: $rt, spreadsheet_id: $sid}')

CATALOG='{"streams":[{"stream":{"name":"users","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'

echo "To use interactively, add this alias:"
echo ""
echo "  alias dest-sheets='$TS scripts/ts-cli.ts ./packages/destination-google-sheets2/src/index.ts'"
echo ""
echo "CONFIG=$CONFIG"
echo "CATALOG=$CATALOG"
echo ""

# ── spec ──────────────────────────────────────────────────────────
echo "$ dest-sheets spec"
$dest_sheets spec | jq .
echo ""

# ── check ─────────────────────────────────────────────────────────
echo "$ dest-sheets check --config '$CONFIG'"
$dest_sheets check --config "$CONFIG" | jq .
echo ""

# ── write ─────────────────────────────────────────────────────────
NOW=$(date +%s000)
NDJSON_BODY=$(cat <<EOF
{"type":"record","stream":"users","data":{"id":"usr_1","name":"Alice","email":"alice@example.com"},"emitted_at":$NOW}
{"type":"record","stream":"users","data":{"id":"usr_2","name":"Bob","email":"bob@example.com"},"emitted_at":$NOW}
{"type":"record","stream":"users","data":{"id":"usr_3","name":"Charlie","email":"charlie@example.com"},"emitted_at":$NOW}
{"type":"state","stream":"users","data":{"cursor":"usr_3"}}
{"type":"record","stream":"users","data":{"id":"usr_4","name":"Diana","email":"diana@example.com"},"emitted_at":$NOW}
{"type":"record","stream":"users","data":{"id":"usr_5","name":"Eve","email":"eve@example.com"},"emitted_at":$NOW}
{"type":"state","stream":"users","data":{"cursor":"usr_5","status":"complete"}}
EOF
)
cat <<COMMAND
$ cat <<NDJSON | dest-sheets write \\
    --config '$CONFIG' \\
    --catalog '$CATALOG'
$NDJSON_BODY
NDJSON
COMMAND
echo ""
echo "$NDJSON_BODY" | $dest_sheets write --config "$CONFIG" --catalog "$CATALOG" | jq -c '{type, stream}'
echo ""

# ── verify ────────────────────────────────────────────────────────
echo "Check the spreadsheet:"
echo "  https://docs.google.com/spreadsheets/d/$GOOGLE_SPREADSHEET_ID"
