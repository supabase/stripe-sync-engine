#!/usr/bin/env bash
#
# E2E test: Stripe → Google Sheets via Temporal Workflow
#
# Tests the full production topology with Stripe source → Google Sheets destination:
#   - Stateless API (sync-engine serve)
#   - Temporal worker (polls task queue, calls API)
#   - Workflow syncs products into a Google Sheet
#
# No webhook bridge or stripe listen — this only tests backfill.
#
# Prerequisites:
#   - STRIPE_API_KEY env var
#   - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN env vars
#   - docker (for Temporal)
#   - pnpm build && cd infra/temporal_ts && pnpm build
#
# Usage:
#   ./tests/e2e-temporal-sheets.sh
#   GOOGLE_SPREADSHEET_ID=<id> ./tests/e2e-temporal-sheets.sh  # reuse existing sheet

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Configuration ────────────────────────────────────────────────

STRIPE_API_KEY="${STRIPE_API_KEY:?STRIPE_API_KEY is required}"
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:?GOOGLE_CLIENT_ID is required}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:?GOOGLE_CLIENT_SECRET is required}"
GOOGLE_REFRESH_TOKEN="${GOOGLE_REFRESH_TOKEN:?GOOGLE_REFRESH_TOKEN is required}"
GOOGLE_SPREADSHEET_ID="${GOOGLE_SPREADSHEET_ID:-}"
TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-localhost:7233}"

# ── Unique identifiers ──────────────────────────────────────────

TS=$(date +%s)
WORKFLOW_ID="e2e-sheets-${TS}"

# ── Track background PIDs ───────────────────────────────────────

PIDS=()
COMPOSE_UP=false

cleanup() {
  echo ""
  echo "=== Cleanup ==="

  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done

  if $COMPOSE_UP; then
    echo "Stopping docker compose services..."
    docker compose -f "$REPO_ROOT/compose.yml" stop temporal temporal-db 2>/dev/null || true
  fi

  echo "Done."
}
trap cleanup EXIT

# ── Helpers ──────────────────────────────────────────────────────

log() { echo "[$1] $2"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

wait_for_port() {
  local port=$1 label=$2 timeout=${3:-30}
  local elapsed=0
  while ! nc -z 127.0.0.1 "$port" 2>/dev/null; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$timeout" ]; then
      fail "${label} not ready on port ${port} after ${timeout}s"
    fi
  done
  log "OK" "${label} ready on port ${port} (${elapsed}s)"
}

find_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()'
}

# ── Step 0: Validate prereqs ────────────────────────────────────

echo "=== E2E: Stripe → Google Sheets via Temporal ==="
echo ""
echo "Config:"
echo "  TEMPORAL_ADDRESS:     ${TEMPORAL_ADDRESS}"
echo "  GOOGLE_SPREADSHEET_ID: ${GOOGLE_SPREADSHEET_ID:-<will create new>}"
echo "  WORKFLOW_ID:          ${WORKFLOW_ID}"
echo ""

log "PREREQ" "Checking prerequisites..."

command -v docker &>/dev/null || fail "docker not found"
command -v node &>/dev/null   || fail "node not found"
command -v curl &>/dev/null   || fail "curl not found"

[ -f "$REPO_ROOT/apps/engine/dist/cli/index.js" ] \
  || fail "sync-engine not built — run 'pnpm build' first"
[ -f "$REPO_ROOT/infra/temporal_ts/dist/worker.js" ] \
  || fail "temporal worker not built — run 'cd infra/temporal_ts && pnpm build' first"

log "OK" "All prerequisites found"
echo ""

# ── Step 1: Get access token from refresh token ─────────────────

log "AUTH" "Exchanging refresh token for access token..."

TOKEN_RESPONSE=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d "client_id=${GOOGLE_CLIENT_ID}" \
  -d "client_secret=${GOOGLE_CLIENT_SECRET}" \
  -d "refresh_token=${GOOGLE_REFRESH_TOKEN}" \
  -d "grant_type=refresh_token")

GOOGLE_ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)

if [ -z "$GOOGLE_ACCESS_TOKEN" ]; then
  echo "Token response: $TOKEN_RESPONSE"
  fail "Failed to get Google access token"
fi

log "OK" "Got access token (${#GOOGLE_ACCESS_TOKEN} chars)"
echo ""

# ── Step 2: Start Docker services ───────────────────────────────

log "DOCKER" "Starting Temporal via docker compose..."
docker compose -f "$REPO_ROOT/compose.yml" up -d temporal
COMPOSE_UP=true

log "DOCKER" "Waiting for Temporal..."
wait_for_port 7233 "Temporal" 90
echo ""

# ── Step 3: Start stateless API ─────────────────────────────────

API_PORT=$(find_free_port)
log "API" "Starting stateless API on port ${API_PORT}..."

PORT="$API_PORT" node "$REPO_ROOT/apps/engine/dist/cli/index.js" \
  > /tmp/e2e-sheets-api-${TS}.log 2>&1 &
PIDS+=($!)

wait_for_port "$API_PORT" "Stateless API" 15

ENGINE_URL="http://localhost:${API_PORT}"
echo ""

# ── Step 4: Start Temporal worker ───────────────────────────────

log "WORKER" "Starting Temporal worker..."

ENGINE_URL="$ENGINE_URL" \
TEMPORAL_ADDRESS="$TEMPORAL_ADDRESS" \
  node "$REPO_ROOT/infra/temporal_ts/dist/worker.js" \
  > /tmp/e2e-sheets-worker-${TS}.log 2>&1 &
PIDS+=($!)

sleep 3
log "OK" "Worker started (PID ${PIDS[-1]})"
echo ""

# ── Step 5: Start workflow via tctl ─────────────────────────────

log "WORKFLOW" "Starting syncWorkflow via tctl..."

CONFIG_JSON=$(cat <<EOF
{
  "source_name": "stripe",
  "destination_name": "google-sheets",
  "source_config": {
    "api_key": "${STRIPE_API_KEY}",
    "backfill_limit": 5
  },
  "destination_config": {
    "client_id": "${GOOGLE_CLIENT_ID}",
    "client_secret": "${GOOGLE_CLIENT_SECRET}",
    "access_token": "${GOOGLE_ACCESS_TOKEN}",
    "refresh_token": "${GOOGLE_REFRESH_TOKEN}",
    "spreadsheet_id": "${GOOGLE_SPREADSHEET_ID}",
    "spreadsheet_title": "E2E Temporal Sheets ${TS}"
  },
  "streams": [{"name": "products"}]
}
EOF
)

docker compose -f "$REPO_ROOT/compose.yml" exec -T temporal \
  tctl workflow start \
    --workflow_type syncWorkflow \
    --taskqueue sync-engine \
    --workflow_id "$WORKFLOW_ID" \
    --input "$CONFIG_JSON" \
  2>&1 | head -5

log "OK" "Workflow ${WORKFLOW_ID} started"
echo ""

# ── Step 6: Poll workflow status until backfill completes ────────

log "BACKFILL" "Polling workflow status until backfill completes..."

ELAPSED=0
TIMEOUT=120
while true; do
  # Query workflow status via tctl (output is "Query result:\n[{json}]")
  STATUS_RAW=$(docker compose -f "$REPO_ROOT/compose.yml" exec -T temporal \
    tctl workflow query \
      --workflow_id "$WORKFLOW_ID" \
      --query_type status \
    2>/dev/null || echo '')

  PHASE=$(echo "$STATUS_RAW" | python3 -c "
import sys, json
try:
    lines = sys.stdin.read().strip().splitlines()
    # Skip 'Query result:' prefix, parse the JSON array
    for line in lines:
        line = line.strip()
        if line.startswith('[') or line.startswith('{'):
            data = json.loads(line)
            if isinstance(data, list) and len(data) > 0:
                data = data[0]
            print(data.get('phase', ''))
            break
    else:
        print('')
except:
    print('')
" 2>/dev/null)

  if [ "$PHASE" = "live" ]; then
    log "OK" "Backfill complete — workflow in live phase (${ELAPSED}s)"
    break
  fi

  sleep 3
  ELAPSED=$((ELAPSED + 3))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "Last status: $STATUS_JSON"
    fail "Workflow did not reach live phase after ${TIMEOUT}s"
  fi

  if [ $((ELAPSED % 15)) -eq 0 ]; then
    log "WAIT" "Phase: ${PHASE:-unknown} (${ELAPSED}s elapsed)"
  fi
done
echo ""

# ── Step 7: Verify data in Google Sheets ─────────────────────────

log "VERIFY" "Reading products sheet from Google Sheets..."

# Get the spreadsheet ID from the API log (the engine logs it)
if [ -n "$GOOGLE_SPREADSHEET_ID" ]; then
  SHEET_ID="$GOOGLE_SPREADSHEET_ID"
else
  # Extract from API log: "Sheets destination: wrote to spreadsheet <id>"
  SHEET_ID=$(grep -o 'wrote to spreadsheet [^ ]*' /tmp/e2e-sheets-api-${TS}.log 2>/dev/null \
    | tail -1 | awk '{print $NF}')
fi

if [ -z "$SHEET_ID" ]; then
  log "WARN" "Could not determine spreadsheet ID from logs"
  log "WARN" "API log:"
  cat /tmp/e2e-sheets-api-${TS}.log 2>/dev/null || true
  fail "No spreadsheet ID found"
fi

log "INFO" "Spreadsheet: https://docs.google.com/spreadsheets/d/${SHEET_ID}"

# Read data from the products sheet via Sheets API
SHEET_DATA=$(curl -s \
  -H "Authorization: Bearer ${GOOGLE_ACCESS_TOKEN}" \
  "https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/products")

ROW_COUNT=$(echo "$SHEET_DATA" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    values = data.get('values', [])
    # First row is headers, rest is data
    print(max(0, len(values) - 1))
except:
    print(0)
" 2>/dev/null)

echo ""

# ── Step 8: Assert results ───────────────────────────────────────

echo "=== Results ==="
echo "  Spreadsheet: https://docs.google.com/spreadsheets/d/${SHEET_ID}"
echo "  Products:    ${ROW_COUNT} rows (excluding header)"
echo ""

if [ "$ROW_COUNT" -gt 0 ]; then
  echo "=== PASS: E2E Temporal Sheets test succeeded ==="
else
  echo "Sheet data response:"
  echo "$SHEET_DATA" | python3 -m json.tool 2>/dev/null || echo "$SHEET_DATA"
  fail "Expected > 0 product rows, got ${ROW_COUNT}"
fi
