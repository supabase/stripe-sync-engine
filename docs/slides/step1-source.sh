#!/usr/bin/env bash
# Step 1: source only — reads from Stripe, emits NDJSON to stdout
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; source "$(dirname "$0")/_common.sh"
: "${STRIPE_API_KEY:?Set STRIPE_API_KEY}"

CATALOG='{"streams":[{"stream":{"name":"products"},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'
SRC_CONFIG='{"api_key":"'"$STRIPE_API_KEY"'","backfill_limit":5}'

source-stripe read --config "$SRC_CONFIG" --catalog "$CATALOG"
