#!/usr/bin/env bash
set -euo pipefail

# Test sync against all configured Stripe accounts.
# Usage:
#   ./scripts/test-all-accounts.sh              # run all accounts
#   ./scripts/test-all-accounts.sh qa_demo      # run one account
#   ./scripts/test-all-accounts.sh --quick      # backfill-limit 20, time-limit 30

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

source .envrc 2>/dev/null || true

POSTGRES_URL="postgresql://postgres:postgres@localhost:55432/postgres?sslmode=disable"
EXTRA_ARGS=()

if [[ "${1:-}" == "--quick" ]]; then
  EXTRA_ARGS=(--backfill-limit 20 --time-limit 30)
  shift
fi

run_sync() {
  local name="$1" key="$2" base_url="${3:-}"
  local schema="test_${name}"
  local base_flag=()
  if [[ -n "$base_url" ]]; then
    base_flag=(--base-url "$base_url")
  fi

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $name"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  env -u PG_PROXY_HOST -u PG_PROXY_PORT \
    LOG_LEVEL=info LOG_PRETTY=true \
    node --use-env-proxy --import tsx apps/engine/src/bin/sync-engine.ts sync \
    --stripe-api-key "$key" \
    "${base_flag[@]}" \
    --postgres-url "$POSTGRES_URL" \
    --schema "$schema" \
    --state none \
    "${EXTRA_ARGS[@]}"
}

declare -A ACCOUNTS
ACCOUNTS[qa_demo]="$STRIPE_API_KEY_QA_STRIPE_SYNC_DEMO|https://qa-api.stripe.com"
ACCOUNTS[qa_test_inc]="$STRIPE_API_KEY_QA_TEST_INC|https://qa-api.stripe.com"
ACCOUNTS[prod_alka]="$STRIPE_API_KEY_PROD_ALKA|"
ACCOUNTS[prod_wip]="$STRIPE_API_KEY_PROD_WORKS_IN_PROGRESS|"
ACCOUNTS[prod_goldilocks_rk]="$STRIPE_API_KEY_PROD_GOLDILOCKS|"
ACCOUNTS[prod_goldilocks_sk]="$STRIPE_API_KEY_GOLDILOCKS_PROD|"
ACCOUNTS[prod_stripe_demo]="$STRIPE_API_KEY_PROD_STRIPE_DEMO|"

# Order: small → large
ORDER=(qa_demo qa_test_inc prod_alka prod_wip prod_goldilocks_rk prod_goldilocks_sk prod_stripe_demo)

filter="${1:-}"

for name in "${ORDER[@]}"; do
  if [[ -n "$filter" && "$name" != "$filter" ]]; then
    continue
  fi
  IFS='|' read -r key base_url <<< "${ACCOUNTS[$name]}"
  run_sync "$name" "$key" "$base_url"
done
