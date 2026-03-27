#!/usr/bin/env bash
# End-to-end test: Service (config resolution) → Engine (sync execution)
#
# Tests the same flow that Temporal activities execute:
#   1. Create pipelines via service API (Postgres + optionally Google Sheets)
#   2. GET /pipelines/{id} → resolved config
#   3. POST /setup, /sync, /teardown on engine with X-Pipeline
#   4. Verify data landed, verify teardown
#
# Env vars:
#   STRIPE_API_KEY          (required)
#   POSTGRES_URL            (default: postgresql://postgres:postgres@localhost:5432/postgres)
#   GOOGLE_CLIENT_ID        (optional — enables Sheets sync)
#   GOOGLE_CLIENT_SECRET    (optional — enables Sheets sync)
#   GOOGLE_REFRESH_TOKEN    (optional — enables Sheets sync)
#   GOOGLE_SPREADSHEET_ID   (optional — reuses existing sheet; omit to auto-create)
#   SKIP_DELETE=1           skip teardown + cleanup (leave data for inspection)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load .env if present
[ -f .env ] && set -a && source .env && set +a

: "${STRIPE_API_KEY:?Set STRIPE_API_KEY}"
POSTGRES_URL="${POSTGRES_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"
SCHEMA="temporal_sh_$(date +%Y%m%d%H%M%S)_$$"
SKIP_DELETE="${SKIP_DELETE:-}"

SERVICE_PORT=0
ENGINE_PORT=0
SERVICE_PID=""
ENGINE_PID=""

cleanup() {
  echo ""
  echo "--- Cleanup ---"
  [ -n "$SERVICE_PID" ] && kill "$SERVICE_PID" 2>/dev/null && echo "  Stopped service ($SERVICE_PID)"
  [ -n "$ENGINE_PID" ] && kill "$ENGINE_PID" 2>/dev/null && echo "  Stopped engine ($ENGINE_PID)"
  if [ -z "$SKIP_DELETE" ]; then
    psql "$POSTGRES_URL" -c "DROP SCHEMA IF EXISTS \"$SCHEMA\" CASCADE" 2>/dev/null && echo "  Dropped schema $SCHEMA"
  else
    echo "  SKIP_DELETE: keeping schema $SCHEMA"
  fi
  [ -n "${DATA_DIR:-}" ] && rm -rf "$DATA_DIR" && echo "  Removed $DATA_DIR"
}
trap cleanup EXIT

find_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()'
}

wait_for_port() {
  local port=$1 label=$2 timeout=${3:-30}
  for i in $(seq 1 "$timeout"); do
    if nc -z 127.0.0.1 "$port" 2>/dev/null; then
      echo "  $label is up (port $port)"
      return 0
    fi
    sleep 1
  done
  echo "  FAIL: $label not reachable on port $port after ${timeout}s"
  exit 1
}

# Resolve a pipeline's config and build X-Pipeline header value
resolve_params() {
  local sync_id=$1
  curl -sf "$SERVICE_URL/pipelines/$sync_id" | python3 -c "
import sys, json
c = json.load(sys.stdin)
print(json.dumps({
  'source': c['source'],
  'destination': c['destination'],
  'streams': c.get('streams', [])
}))
"
}

# Run the full setup → sync → verify → teardown cycle for a sync
run_sync_cycle() {
  local label=$1 sync_id=$2 verify_fn=$3

  echo ""
  echo "=== $label ==="

  # Resolve
  local params
  params=$(resolve_params "$sync_id")
  echo "  Resolved config ($(echo "$params" | wc -c | tr -d ' ') bytes)"

  # Setup
  local status
  status=$(curl -sf -o /dev/null -w "%{http_code}" -X POST "$ENGINE_URL/setup" \
    -H "X-Pipeline: $params")
  echo "  Setup: HTTP $status"
  [ "$status" = "204" ] || { echo "FAIL: expected 204, got $status"; exit 1; }

  # Sync
  local output
  output=$(curl -sf -X POST "$ENGINE_URL/sync" -H "X-Pipeline: $params")
  local lines
  lines=$(echo "$output" | wc -l | tr -d ' ')
  echo "  Sync: $lines NDJSON lines"

  local errors
  errors=$(echo "$output" | python3 -c "
import sys, json
n = 0
for line in sys.stdin:
  line = line.strip()
  if not line: continue
  msg = json.loads(line)
  if msg.get('type') == 'error':
    n += 1
    print(f'  ERROR: {msg.get(\"message\", \"unknown\")}', file=sys.stderr)
print(n)
")
  [ "$errors" = "0" ] || echo "  ⚠ $errors error(s)"

  # Verify (caller-provided function)
  $verify_fn

  # Teardown
  if [ -z "$SKIP_DELETE" ]; then
    status=$(curl -sf -o /dev/null -w "%{http_code}" -X POST "$ENGINE_URL/teardown" \
      -H "X-Pipeline: $params")
    echo "  Teardown: HTTP $status"
    [ "$status" = "204" ] || { echo "FAIL: expected 204, got $status"; exit 1; }
  else
    echo "  Teardown: skipped (SKIP_DELETE)"
  fi
}

# ── Start servers ──────────────────────────────────────────────────

ENGINE_PORT=$(find_free_port)
echo "Starting engine on port $ENGINE_PORT ..."
(cd "$ROOT/apps/engine" && PORT=$ENGINE_PORT node dist/api/index.js) &>/dev/null &
ENGINE_PID=$!
wait_for_port "$ENGINE_PORT" "Engine"

SERVICE_PORT=$(find_free_port)
DATA_DIR=$(mktemp -d)
echo "Starting service on port $SERVICE_PORT ..."
node "$ROOT/apps/service/dist/bin/cli.js" serve \
  --port "$SERVICE_PORT" \
  --data-dir "$DATA_DIR" &>/dev/null &
SERVICE_PID=$!
wait_for_port "$SERVICE_PORT" "Service"

SERVICE_URL="http://localhost:$SERVICE_PORT"
ENGINE_URL="http://localhost:$ENGINE_PORT"

echo ""
echo "  Service:  $SERVICE_URL"
echo "  Engine:   $ENGINE_URL"
echo "  Postgres: $POSTGRES_URL"
[ -n "$SKIP_DELETE" ] && echo "  Mode:     SKIP_DELETE (data preserved)"

# ── Sync 1: Stripe → Postgres ─────────────────────────────────────

echo ""
echo "--- Creating Postgres pipeline ---"
PG_SYNC_RESP=$(curl -sf -X POST "$SERVICE_URL/pipelines" \
  -H 'Content-Type: application/json' \
  -d "{
    \"source\": { \"name\": \"stripe\", \"api_key\": \"$STRIPE_API_KEY\", \"backfill_limit\": 5 },
    \"destination\": { \"name\": \"postgres\", \"connection_string\": \"$POSTGRES_URL\", \"schema\": \"$SCHEMA\" },
    \"streams\": [{ \"name\": \"products\" }]
  }")
PG_SYNC_ID=$(echo "$PG_SYNC_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "  Pipeline: $PG_SYNC_ID (schema: $SCHEMA)"

verify_postgres() {
  local count
  count=$(psql "$POSTGRES_URL" -t -c "SELECT count(*) FROM \"$SCHEMA\".\"products\"" | tr -d ' ')
  echo "  Verify: $count rows in $SCHEMA.products"
  [ "$count" -gt 0 ] || { echo "FAIL: expected > 0 rows"; exit 1; }

  local sample
  sample=$(psql "$POSTGRES_URL" -t -c "SELECT id FROM \"$SCHEMA\".\"products\" LIMIT 1" | tr -d ' ')
  echo "  Sample: $sample"
  [[ "$sample" == prod_* ]] || { echo "FAIL: expected prod_ prefix"; exit 1; }

  if [ -z "$SKIP_DELETE" ]; then
    # Will be verified after teardown
    :
  else
    echo "  Data preserved: psql $POSTGRES_URL -c 'SELECT * FROM \"$SCHEMA\".\"products\" LIMIT 5'"
  fi
}

run_sync_cycle "Stripe → Postgres" "$PG_SYNC_ID" verify_postgres

# Verify teardown actually dropped the schema
if [ -z "$SKIP_DELETE" ]; then
  TABLE_COUNT=$(psql "$POSTGRES_URL" -t -c \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = '$SCHEMA'" | tr -d ' ')
  echo "  Post-teardown: $TABLE_COUNT tables remaining"
  [ "$TABLE_COUNT" -eq 0 ] || { echo "FAIL: expected 0 tables after teardown"; exit 1; }
fi

# ── Sync 2: Stripe → Google Sheets (optional) ─────────────────────

if [ -n "${GOOGLE_CLIENT_ID:-}" ] && [ -n "${GOOGLE_CLIENT_SECRET:-}" ] && \
   [ -n "${GOOGLE_REFRESH_TOKEN:-}" ]; then

  echo ""
  echo "--- Creating Google Sheets pipeline ---"

  # Build destination config — reuse existing spreadsheet if GOOGLE_SPREADSHEET_ID is set
  SHEETS_DEST="{
    \"name\": \"google-sheets\",
    \"client_id\": \"$GOOGLE_CLIENT_ID\",
    \"client_secret\": \"$GOOGLE_CLIENT_SECRET\",
    \"refresh_token\": \"$GOOGLE_REFRESH_TOKEN\",
    \"access_token\": \"placeholder\""
  if [ -n "${GOOGLE_SPREADSHEET_ID:-}" ]; then
    SHEETS_DEST="$SHEETS_DEST, \"spreadsheet_id\": \"$GOOGLE_SPREADSHEET_ID\""
    echo "  Reusing spreadsheet: $GOOGLE_SPREADSHEET_ID"
  else
    echo "  No GOOGLE_SPREADSHEET_ID set — connector will create a new spreadsheet"
  fi
  SHEETS_DEST="$SHEETS_DEST }"

  SHEETS_SYNC_RESP=$(curl -sf -X POST "$SERVICE_URL/pipelines" \
    -H 'Content-Type: application/json' \
    -d "{
      \"source\": { \"name\": \"stripe\", \"api_key\": \"$STRIPE_API_KEY\", \"backfill_limit\": 3 },
      \"destination\": $SHEETS_DEST,
      \"streams\": [{ \"name\": \"products\" }]
    }")
  SHEETS_SYNC_ID=$(echo "$SHEETS_SYNC_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
  echo "  Pipeline: $SHEETS_SYNC_ID (spreadsheet: ${GOOGLE_SPREADSHEET_ID:-auto-created})"

  verify_sheets() {
    if [ -z "${GOOGLE_SPREADSHEET_ID:-}" ]; then
      echo "  Verify: skipped (no GOOGLE_SPREADSHEET_ID to read back)"
      return
    fi

    # Read back via Sheets API using python + google-auth
    local row_count
    row_count=$(python3 -c "
import json, urllib.request, urllib.parse

# Get access token via refresh
data = urllib.parse.urlencode({
  'client_id': '$GOOGLE_CLIENT_ID',
  'client_secret': '$GOOGLE_CLIENT_SECRET',
  'refresh_token': '$GOOGLE_REFRESH_TOKEN',
  'grant_type': 'refresh_token',
}).encode()
req = urllib.request.Request('https://oauth2.googleapis.com/token', data)
token = json.loads(urllib.request.urlopen(req).read())['access_token']

# Read sheet
url = f'https://sheets.googleapis.com/v4/spreadsheets/$GOOGLE_SPREADSHEET_ID/values/products'
req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
resp = json.loads(urllib.request.urlopen(req).read())
rows = resp.get('values', [])
print(len(rows) - 1 if len(rows) > 1 else 0)  # minus header
")
    echo "  Verify: $row_count data rows in 'products' tab"
    [ "$row_count" -gt 0 ] || { echo "FAIL: expected > 0 rows in sheet"; exit 1; }

    if [ -n "$SKIP_DELETE" ]; then
      echo "  Data preserved: https://docs.google.com/spreadsheets/d/$GOOGLE_SPREADSHEET_ID"
    fi
  }

  run_sync_cycle "Stripe → Google Sheets" "$SHEETS_SYNC_ID" verify_sheets
else
  echo ""
  echo "--- Skipping Google Sheets sync (set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN; GOOGLE_SPREADSHEET_ID is optional) ---"
fi

echo ""
echo "=== All checks passed ==="
