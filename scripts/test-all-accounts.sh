#!/usr/bin/env bash
set -euo pipefail

# Test sync against all configured Stripe accounts.
# Usage:
#   ./scripts/test-all-accounts.sh                          # run all accounts
#   ./scripts/test-all-accounts.sh qa_demo                  # run one account
#   ./scripts/test-all-accounts.sh --quick                  # backfill-limit 20, time-limit 30
#   ./scripts/test-all-accounts.sh --no-cache               # disable fs state (--state none)
#   ./scripts/test-all-accounts.sh --verify                 # reconcile Sigma vs Postgres (no sync)
#   ./scripts/test-all-accounts.sh --backfill-limit 50      # explicit backfill limit
#   ./scripts/test-all-accounts.sh --time-limit 60          # explicit time limit (seconds)
#   ./scripts/test-all-accounts.sh --rate-limit 40          # explicit Stripe rate limit
#   ./scripts/test-all-accounts.sh --streams customers,invoices  # only sync these streams

trap 'echo ""; echo "Interrupted."; exit 130' INT

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

source .envrc 2>/dev/null || true

POSTGRES_URL="postgresql://postgres:postgres@localhost:55432/postgres?sslmode=disable"
STATE_DIR="$HOME/.test-all-accounts"
EXTRA_ARGS=()
MODE="sync"
RATE_LIMIT=80
STATE_MODE="file"

# Parse flags (can appear in any position)
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick) EXTRA_ARGS+=(--backfill-limit 20 --time-limit 30); shift ;;
    --no-cache) STATE_MODE="none"; shift ;;
    --verify) MODE="verify"; shift ;;
    --backfill-limit) EXTRA_ARGS+=(--backfill-limit "$2"); shift 2 ;;
    --time-limit) EXTRA_ARGS+=(--time-limit "$2"); shift 2 ;;
    --rate-limit) RATE_LIMIT="$2"; shift 2 ;;
    --streams) EXTRA_ARGS+=(--streams "$2"); shift 2 ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done
set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

run_sync() {
  local name="$1" key="$2" base_url="${3:-}"
  local schema="test_${name}"
  local base_flag=()
  if [[ -n "$base_url" ]]; then
    base_flag=(--stripe-base-url "$base_url")
  fi

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $name"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  env -u PG_PROXY_HOST -u PG_PROXY_PORT \
    LOG_LEVEL=info LOG_PRETTY=true \
    node --use-env-proxy --conditions bun --import tsx apps/engine/src/bin/sync-engine.ts sync \
    --stripe-api-key "$key" \
    "${base_flag[@]}" \
    --postgres-url "$POSTGRES_URL" \
    --postgres-schema "$schema" \
    --state "$STATE_MODE" \
    --state-dir "$STATE_DIR" \
    --stripe-rate-limit "$RATE_LIMIT" \
    "${EXTRA_ARGS[@]}"
}

run_verify() {
  local name="$1" key="$2"
  local schema="test_${name}"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $name (verify)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  mkdir -p tmp
  local report="tmp/verify-${name}.json"
  bun scripts/reconcile-sigma-vs-postgres.ts \
    --stripe-api-key "$key" \
    --db-url "${POSTGRES_URL}&options=-csearch_path%3D${schema}" \
    --output "$report"
}

declare -A ACCOUNTS
ACCOUNTS[qa_demo]="$STRIPE_API_KEY_QA_STRIPE_SYNC_DEMO|https://qa-api.stripe.com"
ACCOUNTS[qa_test_inc]="$STRIPE_API_KEY_QA_TEST_INC|https://qa-api.stripe.com"
ACCOUNTS[prod_alka]="$STRIPE_API_KEY_PROD_ALKA|"
ACCOUNTS[prod_alka_sk]="$STRIPE_API_KEY_PROD_ALKA_SK|"
ACCOUNTS[prod_wip]="$STRIPE_API_KEY_PROD_WORKS_IN_PROGRESS|"
ACCOUNTS[prod_goldilocks_rk]="$STRIPE_API_KEY_PROD_GOLDILOCKS|"
ACCOUNTS[prod_goldilocks_sk]="$STRIPE_API_KEY_GOLDILOCKS_PROD|"
ACCOUNTS[prod_stripe_demo]="$STRIPE_API_KEY_PROD_STRIPE_DEMO|"
ACCOUNTS[prod_shop]="$STRIPE_API_KEY_PROD_SHOP|"

# Order: small → large
ORDER=(qa_demo qa_test_inc prod_alka prod_alka_sk prod_wip prod_goldilocks_rk prod_goldilocks_sk prod_stripe_demo prod_shop)

filter="${1:-}"

for name in "${ORDER[@]}"; do
  if [[ -n "$filter" && "$name" != "$filter" ]]; then
    continue
  fi
  IFS='|' read -r key base_url <<< "${ACCOUNTS[$name]}"
  if [[ "$MODE" == "verify" ]]; then
    run_verify "$name" "$key"
  else
    run_sync "$name" "$key" "$base_url"
  fi
done
