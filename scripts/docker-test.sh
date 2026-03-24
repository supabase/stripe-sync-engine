#!/usr/bin/env bash
# Test the Docker image via the stateless HTTP API.
#
# 1) Health check
# 2) Source: read from Stripe (/read)
# 3) Destination: write to Google Sheets (/write)
#
# Env: STRIPE_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_SPREADSHEET_ID
set -euo pipefail

IMAGE="${IMAGE:-stripe/sdb}"
CONTAINER="sync-engine-docker-test-$$"
PORT=3199

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> Starting $IMAGE on :$PORT"
docker run -d --name "$CONTAINER" -p "$PORT:3000" "$IMAGE"

echo "==> Waiting for health..."
for i in $(seq 1 20); do
  if curl -sf "http://localhost:$PORT/health" >/dev/null; then
    echo "    OK"
    break
  fi
  [ "$i" -eq 20 ] && { echo "FAIL: health check timed out"; exit 1; }
  sleep 0.5
done

# --- 1) Read from Stripe ---
echo "==> Reading from Stripe (/read)"
READ_PARAMS=$(cat <<'JSON'
{
  "source_name": "stripe",
  "source_config": {
    "api_key": "$STRIPE_API_KEY",
    "backfill_limit": 5
  },
  "destination_name": "printer",
  "destination_config": {},
  "streams": [{"name": "products"}]
}
JSON
)
# Substitute env var (jq not required — simple envsubst)
READ_PARAMS=$(echo "$READ_PARAMS" | sed "s/\$STRIPE_API_KEY/$STRIPE_API_KEY/")

STRIPE_OUTPUT=$(curl -sf -X POST "http://localhost:$PORT/read" \
  -H "X-Sync-Params: $READ_PARAMS")

RECORD_COUNT=$(echo "$STRIPE_OUTPUT" | grep -c '"type":"record"' || true)
echo "    Got $RECORD_COUNT record(s)"
echo "$STRIPE_OUTPUT" | head -3
[ "$RECORD_COUNT" -gt 0 ] || { echo "FAIL: no records from Stripe"; exit 1; }

# --- 2) Write to Google Sheets ---
echo "==> Writing to Google Sheets (/write)"
WRITE_PARAMS=$(cat <<JSON
{
  "source_name": "stripe",
  "source_config": {},
  "destination_name": "google-sheets",
  "destination_config": {
    "client_id": "$GOOGLE_CLIENT_ID",
    "client_secret": "$GOOGLE_CLIENT_SECRET",
    "access_token": "unused",
    "refresh_token": "$GOOGLE_REFRESH_TOKEN",
    "spreadsheet_id": "$GOOGLE_SPREADSHEET_ID"
  }
}
JSON
)

# Pipe the Stripe output into /write
WRITE_OUTPUT=$(echo "$STRIPE_OUTPUT" | curl -sf -X POST "http://localhost:$PORT/write" \
  -H "X-Sync-Params: $WRITE_PARAMS" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @-)

echo "$WRITE_OUTPUT" | head -3
echo "    Sheet: https://docs.google.com/spreadsheets/d/$GOOGLE_SPREADSHEET_ID"
echo "==> Done"
