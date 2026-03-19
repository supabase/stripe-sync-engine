#!/usr/bin/env bash
# source-stripe2 examples
#
# Prerequisites:
#   pnpm install
#   docker compose up -d          # starts stripe-mock on :12111
#
# All commands run from the monorepo root.
#
# Setup:
#   alias source-stripe='bun scripts/ts-cli.ts ./packages/source-stripe2/src/index.ts'
#
# Then:
#   source-stripe spec
#   source-stripe check --config '{"api_key":"sk_test_fake","base_url":"http://localhost:12111"}'
#   source-stripe discover --config '{"api_key":"sk_test_fake","base_url":"http://localhost:12111"}'
#   source-stripe read \
#     --config '{"api_key":"sk_test_fake","base_url":"http://localhost:12111"}' \
#     --catalog '{"streams":[{"stream":{"name":"customers","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'
#   source-stripe read --config '...' --catalog '...' | jq -r 'select(.type == "record") | .data.id'

set -euo pipefail
set -x
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Use bun if available, fall back to node --strip-types
if command -v bun &>/dev/null; then
  TS="bun"
else
  TS="node --strip-types"
fi

# The alias you'd put in your shell profile:
#   alias source-stripe='bun scripts/ts-cli.ts ./packages/source-stripe2/src/index.ts'
source_stripe="$TS $ROOT/scripts/ts-cli.ts $ROOT/packages/source-stripe2/src/index.ts"

# Always use stripe-mock defaults. To test against real Stripe API:
#   STRIPE_MOCK_KEY=sk_test_... STRIPE_BASE_URL="" bash examples.sh
API_KEY="${STRIPE_MOCK_KEY:-sk_test_fake}"
BASE_URL="${STRIPE_BASE_URL:-http://localhost:12111}"

CONFIG="{\"api_key\":\"$API_KEY\",\"base_url\":\"$BASE_URL\"}"

# Catalogs selecting which streams to sync
ALL_CATALOG='{"streams":[{"stream":{"name":"products","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"},{"stream":{"name":"customers","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"},{"stream":{"name":"prices","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"},{"stream":{"name":"invoices","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'
PRODUCTS_CATALOG='{"streams":[{"stream":{"name":"products","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'
CUSTOMERS_CATALOG='{"streams":[{"stream":{"name":"customers","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'

# ── spec: JSON Schema for the connector's config ─────────────────
echo "=== source-stripe spec ==="
$source_stripe spec | jq .

# ── check: verify credentials work ───────────────────────────────
echo ""
echo "=== source-stripe check ==="
$source_stripe check --config "$CONFIG"

# ── discover: list available streams ──────────────────────────────
echo ""
echo "=== source-stripe discover ==="
$source_stripe discover --config "$CONFIG" | jq .

# ── read: single stream ──────────────────────────────────────────
echo ""
echo "=== source-stripe read (products) ==="
$source_stripe read --config "$CONFIG" --catalog "$PRODUCTS_CATALOG" | jq -c .

# ── read: all streams ────────────────────────────────────────────
echo ""
echo "=== source-stripe read (all) ==="
$source_stripe read --config "$CONFIG" --catalog "$ALL_CATALOG" | jq -c '{type, stream, id: .data.id}'

# ── read + jq: extract just record IDs ───────────────────────────
echo ""
echo "=== source-stripe read | jq (IDs only) ==="
$source_stripe read --config "$CONFIG" --catalog "$CUSTOMERS_CATALOG" | jq -r 'select(.type == "record") | .data.id'
