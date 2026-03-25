#!/usr/bin/env bash
#
# E2E test: Stripe CLI → Webhook Bridge → Temporal Workflow → Stateless API → Postgres
#
# Tests the full production topology with separate processes:
#   - Stateless API (sync-engine serve)
#   - Temporal worker (polls task queue, calls API)
#   - Webhook bridge (receives webhooks, signals Temporal)
#   - stripe listen (forwards live Stripe webhooks to bridge)
#
# Worker-agnostic: pass --worker to override the worker command.
#
# Prerequisites:
#   - STRIPE_API_KEY env var (with write permissions)
#   - docker (for Temporal + Postgres)
#   - stripe CLI (for stripe listen)
#   - pnpm build && cd infra/temporal_ts && pnpm build
#
# Usage:
#   ./tests/e2e-temporal-webhook.sh
#   ./tests/e2e-temporal-webhook.sh --worker "node infra/temporal_ts/dist/worker.js"
#   ./tests/e2e-temporal-webhook.sh --worker "bundle exec ruby infra/temporal_ruby/worker.rb"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Configuration ────────────────────────────────────────────────

STRIPE_API_KEY="${STRIPE_API_KEY:?STRIPE_API_KEY is required}"
POSTGRES_URL="${POSTGRES_URL:-postgresql://postgres:postgres@localhost:55432/postgres}"
TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-localhost:7233}"

# Default worker command (TS worker)
WORKER_CMD="node ${REPO_ROOT}/infra/temporal_ts/dist/worker.js"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --worker)
      WORKER_CMD="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

# ── Unique identifiers ──────────────────────────────────────────

TS=$(date +%s)
SCHEMA="e2e_wh_${TS}"
WORKFLOW_ID="e2e-wh-${TS}"

# ── Track background PIDs ───────────────────────────────────────

PIDS=()
COMPOSE_UP=false

cleanup() {
  echo ""
  echo "=== Cleanup ==="

  # Kill background processes
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done

  # Drop test schema
  if command -v psql &>/dev/null; then
    echo "Dropping schema ${SCHEMA}..."
    psql "$POSTGRES_URL" -c "DROP SCHEMA IF EXISTS \"${SCHEMA}\" CASCADE" 2>/dev/null || true
  fi

  # Stop docker compose services we started
  if $COMPOSE_UP; then
    echo "Stopping docker compose services..."
    docker compose -f "$REPO_ROOT/compose.yml" stop temporal temporal-db postgres 2>/dev/null || true
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

poll_psql() {
  local query=$1 label=$2 timeout=${3:-60}
  local elapsed=0
  while true; do
    local result
    result=$(psql "$POSTGRES_URL" -t -A -c "$query" 2>/dev/null || echo "0")
    result=$(echo "$result" | tr -d '[:space:]')
    if [ "$result" != "0" ] && [ -n "$result" ]; then
      log "OK" "${label}: ${result}" >&2
      echo "$result"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
    if [ "$elapsed" -ge "$timeout" ]; then
      fail "${label} timed out after ${timeout}s"
    fi
  done
}

# ── Step 0: Validate prereqs ────────────────────────────────────

echo "=== E2E: Stripe CLI → Webhook Bridge → Temporal → Postgres ==="
echo ""
echo "Config:"
echo "  POSTGRES_URL:     ${POSTGRES_URL}"
echo "  TEMPORAL_ADDRESS: ${TEMPORAL_ADDRESS}"
echo "  WORKER_CMD:       ${WORKER_CMD}"
echo "  SCHEMA:           ${SCHEMA}"
echo "  WORKFLOW_ID:      ${WORKFLOW_ID}"
echo ""

log "PREREQ" "Checking prerequisites..."

command -v docker &>/dev/null || fail "docker not found"
command -v stripe &>/dev/null || fail "stripe CLI not found"
command -v psql &>/dev/null   || fail "psql not found"
command -v node &>/dev/null   || fail "node not found"

[ -f "$REPO_ROOT/apps/engine/dist/cli/index.js" ] \
  || fail "sync-engine not built — run 'pnpm build' first"
[ -f "$REPO_ROOT/infra/temporal_ts/dist/worker.js" ] \
  || fail "temporal worker not built — run 'cd infra/temporal_ts && pnpm build' first"
[ -f "$REPO_ROOT/infra/temporal_ts/dist/webhook-bridge.js" ] \
  || fail "webhook bridge not built — run 'cd infra/temporal_ts && pnpm build' first"

log "OK" "All prerequisites found"
echo ""

# ── Step 1: Start Docker services ───────────────────────────────

log "DOCKER" "Starting Temporal + Postgres via docker compose..."
docker compose -f "$REPO_ROOT/compose.yml" up -d temporal postgres
COMPOSE_UP=true

log "DOCKER" "Waiting for Postgres..."
wait_for_port 55432 "Postgres" 30

log "DOCKER" "Waiting for Temporal..."
wait_for_port 7233 "Temporal" 90
echo ""

# ── Step 2: Start stateless API ─────────────────────────────────

API_PORT=$(find_free_port)
log "API" "Starting stateless API on port ${API_PORT}..."

PORT="$API_PORT" node "$REPO_ROOT/apps/engine/dist/cli/index.js" \
  > /tmp/e2e-api-${TS}.log 2>&1 &
PIDS+=($!)

wait_for_port "$API_PORT" "Stateless API" 15

ENGINE_URL="http://localhost:${API_PORT}"
echo ""

# ── Step 3: Start Temporal worker ───────────────────────────────

log "WORKER" "Starting Temporal worker..."

ENGINE_URL="$ENGINE_URL" \
TEMPORAL_ADDRESS="$TEMPORAL_ADDRESS" \
  $WORKER_CMD > /tmp/e2e-worker-${TS}.log 2>&1 &
PIDS+=($!)

# Give the worker a moment to register
sleep 3
log "OK" "Worker started (PID ${PIDS[-1]})"
echo ""

# ── Step 4: Start workflow via tctl ─────────────────────────────

log "WORKFLOW" "Starting syncWorkflow via tctl..."

CONFIG_JSON=$(cat <<EOF
{
  "source_name": "stripe",
  "destination_name": "postgres",
  "source_config": {
    "api_key": "${STRIPE_API_KEY}",
    "backfill_limit": 5
  },
  "destination_config": {
    "connection_string": "${POSTGRES_URL}",
    "schema": "${SCHEMA}"
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

# ── Step 5: Start webhook bridge ────────────────────────────────

BRIDGE_PORT=$(find_free_port)
log "BRIDGE" "Starting webhook bridge on port ${BRIDGE_PORT}..."

TEMPORAL_ADDRESS="$TEMPORAL_ADDRESS" \
WEBHOOK_BRIDGE_PORT="$BRIDGE_PORT" \
DEFAULT_WORKFLOW_ID="$WORKFLOW_ID" \
  node "$REPO_ROOT/infra/temporal_ts/dist/webhook-bridge.js" \
  > /tmp/e2e-bridge-${TS}.log 2>&1 &
PIDS+=($!)

wait_for_port "$BRIDGE_PORT" "Webhook bridge" 10
echo ""

# ── Step 6: Start stripe listen ─────────────────────────────────

log "STRIPE" "Starting stripe listen → http://localhost:${BRIDGE_PORT}/webhooks"

# stripe listen outputs the webhook signing secret on stderr when ready
STRIPE_LISTEN_LOG="/tmp/e2e-stripe-listen-${TS}.log"

stripe listen --forward-to "http://localhost:${BRIDGE_PORT}/webhooks" \
  > "$STRIPE_LISTEN_LOG" 2>&1 &
PIDS+=($!)

# Wait for stripe listen to be ready (outputs "whsec_" when connected)
ELAPSED=0
while ! grep -q "Ready!" "$STRIPE_LISTEN_LOG" 2>/dev/null; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge 30 ]; then
    echo "stripe listen log:"
    cat "$STRIPE_LISTEN_LOG" || true
    fail "stripe listen not ready after 30s"
  fi
done
log "OK" "stripe listen connected (${ELAPSED}s)"
echo ""

# ── Step 7: Wait for backfill ───────────────────────────────────

log "BACKFILL" "Polling for backfilled products in ${SCHEMA}.products..."

BACKFILL_COUNT=$(poll_psql \
  "SELECT count(*) FROM \"${SCHEMA}\".\"products\"" \
  "Backfill count" \
  120)

echo ""

# ── Step 8: Trigger live event ──────────────────────────────────

log "LIVE" "Triggering product update via Stripe API..."

# Get an existing product ID
PRODUCT_ID=$(psql "$POSTGRES_URL" -t -A -c \
  "SELECT id FROM \"${SCHEMA}\".\"products\" LIMIT 1" 2>/dev/null)

if [ -z "$PRODUCT_ID" ]; then
  fail "No products found in ${SCHEMA}.products after backfill"
fi

NEW_NAME="e2e-wh-${TS}"
log "LIVE" "Updating product ${PRODUCT_ID} → name='${NEW_NAME}'"

stripe products update "$PRODUCT_ID" --name "$NEW_NAME" --api-key "$STRIPE_API_KEY" > /dev/null 2>&1

# ── Step 9: Poll for live event ─────────────────────────────────

log "LIVE" "Polling for updated product name in Postgres..."

LIVE_RESULT=$(poll_psql \
  "SELECT count(*) FROM \"${SCHEMA}\".\"products\" WHERE _raw_data->>'name' = '${NEW_NAME}'" \
  "Live event" \
  60)

echo ""

# ── Step 10: Assert results ─────────────────────────────────────

echo "=== Results ==="
echo "  Backfill: ${BACKFILL_COUNT} products synced"
echo "  Live:     product '${NEW_NAME}' landed (${LIVE_RESULT} match)"
echo ""

if [ "$BACKFILL_COUNT" -gt 0 ] && [ "$LIVE_RESULT" -gt 0 ]; then
  echo "=== PASS: E2E Temporal webhook test succeeded ==="
else
  fail "Expected backfill > 0 and live > 0, got backfill=${BACKFILL_COUNT} live=${LIVE_RESULT}"
fi
