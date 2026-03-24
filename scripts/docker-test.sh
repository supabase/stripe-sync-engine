#!/usr/bin/env bash
# Test the Docker image via the stateless HTTP API.
#
# Usage:
#   ./scripts/docker-test.sh           # build & test local image
#   ./scripts/docker-test.sh local     # same as above
#   ./scripts/docker-test.sh prod      # test stripe/sync-engine:latest (no build)
#   ./scripts/docker-test.sh <image>   # test a specific image (no build)
#
# Required env: STRIPE_API_KEY
# Optional env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_SPREADSHEET_ID
# Optional env: DATABASE_URL (for Postgres write test)
set -euo pipefail

MODE="${1:-local}"

case "$MODE" in
  -h|--help|help)
    echo "Usage: $0 [local|prod|<image>]"
    echo ""
    echo "  local          Build from source and test (default)"
    echo "  prod           Pull and test stripe/sync-engine:latest"
    echo "  <image>        Test a specific image, e.g. sync-engine:test"
    echo ""
    echo "Required env: STRIPE_API_KEY"
    echo "Optional env: DATABASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,"
    echo "              GOOGLE_REFRESH_TOKEN, GOOGLE_SPREADSHEET_ID"
    exit 0
    ;;
  local)
    IMAGE="sync-engine:test"
    BUILD=true
    ;;
  prod)
    IMAGE="stripe/sync-engine:v2"
    BUILD=false
    ;;
  *)
    IMAGE="$MODE"
    BUILD=false
    ;;
esac

CONTAINER="sync-engine-docker-test-$$"
PORT="${PORT:-3199}"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if $BUILD; then
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  echo "==> Building $IMAGE"
  docker build -t "$IMAGE" "$REPO_ROOT"
fi

# Use --network host on Linux (CI), port mapping + host.docker.internal on Mac
if [ "$(uname)" = "Linux" ]; then
  echo "==> Starting $IMAGE (host network, PORT=$PORT)"
  docker run -d --name "$CONTAINER" --network host -e PORT="$PORT" "$IMAGE"
  DOCKER_HOST_ADDR="localhost"
else
  echo "==> Starting $IMAGE on :$PORT"
  docker run -d --name "$CONTAINER" -p "$PORT:3000" --add-host=host.docker.internal:host-gateway "$IMAGE"
  DOCKER_HOST_ADDR="host.docker.internal"
fi

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
READ_PARAMS=$(printf '{"source_name":"stripe","source_config":{"api_key":"%s","backfill_limit":5},"destination_name":"postgres","destination_config":{"url":"postgres://unused:5432/db","schema":"stripe"},"streams":[{"name":"products"}]}' "$STRIPE_API_KEY")

STRIPE_OUTPUT=$(curl -s --max-time 60 -X POST "http://localhost:$PORT/read" \
  -H "X-Sync-Params: $READ_PARAMS")

RECORD_COUNT=$(echo "$STRIPE_OUTPUT" | grep -c '"type":"record"' || true)
echo "    Got $RECORD_COUNT record(s)"
echo "$STRIPE_OUTPUT" | head -3
[ "$RECORD_COUNT" -gt 0 ] || { echo "FAIL: no records from Stripe"; exit 1; }

# --- 2) Write to Google Sheets ---
if [ -n "${GOOGLE_CLIENT_ID:-}" ]; then
  echo "==> Writing to Google Sheets (/write)"
  SHEETS_PARAMS=$(printf '{"source_name":"stripe","source_config":{"api_key":"%s"},"destination_name":"google-sheets","destination_config":{"client_id":"%s","client_secret":"%s","access_token":"unused","refresh_token":"%s","spreadsheet_id":"%s"}}' \
    "$STRIPE_API_KEY" "$GOOGLE_CLIENT_ID" "$GOOGLE_CLIENT_SECRET" "$GOOGLE_REFRESH_TOKEN" "$GOOGLE_SPREADSHEET_ID")

  SHEETS_OUTPUT=$(echo "$STRIPE_OUTPUT" | curl -s --max-time 60 -X POST "http://localhost:$PORT/write" \
    -H "X-Sync-Params: $SHEETS_PARAMS" \
    -H "Content-Type: application/x-ndjson" \
    --data-binary @-)

  echo "$SHEETS_OUTPUT" | head -3
  echo "    Sheet: https://docs.google.com/spreadsheets/d/$GOOGLE_SPREADSHEET_ID"
else
  echo "==> Skipping Google Sheets write (GOOGLE_CLIENT_ID not set)"
fi

# --- 3) Write to Postgres ---
if [ -n "${DATABASE_URL:-}" ]; then
  # Rewrite localhost for Docker container access
  DOCKER_PG_URL="${DATABASE_URL//localhost/$DOCKER_HOST_ADDR}"
  echo "==> Setting up Postgres (/setup) → $DOCKER_PG_URL"
  PG_PARAMS=$(printf '{"source_name":"stripe","source_config":{"api_key":"%s"},"destination_name":"postgres","destination_config":{"url":"%s","schema":"stripe_docker_test"}}' \
    "$STRIPE_API_KEY" "$DOCKER_PG_URL")

  curl -sf --max-time 30 -X POST "http://localhost:$PORT/setup" \
    -H "X-Sync-Params: $PG_PARAMS" && echo "    OK" || echo "    setup returned non-204 (may be fine)"

  echo "==> Writing to Postgres (/write)"
  PG_WRITE_OUTPUT=$(echo "$STRIPE_OUTPUT" | curl -s --max-time 60 -X POST "http://localhost:$PORT/write" \
    -H "X-Sync-Params: $PG_PARAMS" \
    -H "Content-Type: application/x-ndjson" \
    --data-binary @-)
  echo "$PG_WRITE_OUTPUT" | head -3
  echo "    Database: $DATABASE_URL schema=stripe_docker_test"
else
  echo "==> Skipping Postgres write (DATABASE_URL not set)"
fi

echo "==> Done"
