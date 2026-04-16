#!/usr/bin/env bash
# demo-webhooksite.sh
#
# Demonstrates @webhooksite/cli for local Stripe webhook development.
#
# Workflow:
#   1. Create a free webhook.site token (public URL, no account needed)
#   2. Register that URL as a Stripe webhook endpoint
#   3. Run `whcli forward` to pipe incoming webhooks to your local service
#
# Usage:
#   ./scripts/demo-webhooksite.sh [local-target]
#
# Examples:
#   ./scripts/demo-webhooksite.sh                      # default: http://localhost:3000
#   ./scripts/demo-webhooksite.sh http://localhost:8080/webhooks
#   WH_API_KEY=your-api-key ./scripts/demo-webhooksite.sh   # with API key (higher rate limits)
#
# Prerequisites:
#   - pnpm install (whcli available via pnpm exec)
#   - Optional: Stripe CLI (`stripe listen` is the simpler alternative for pure Stripe use)

set -euo pipefail

LOCAL_TARGET="${1:-http://localhost:3000}"

# ── Step 1: Create a free webhook.site token ──────────────────────────────────
echo "Creating webhook.site token..."

TOKEN_RESPONSE=$(curl -s -X POST "https://webhook.site/token" \
  -H "Content-Type: application/json" \
  -d '{"default_status": 200, "default_content": "OK", "default_content_type": "text/plain"}')

TOKEN_ID=$(echo "$TOKEN_RESPONSE" | grep -o '"uuid":"[^"]*"' | head -1 | cut -d'"' -f4)

if [[ -z "$TOKEN_ID" ]]; then
  echo "Error: failed to create token. Response: $TOKEN_RESPONSE"
  exit 1
fi

WEBHOOK_URL="https://webhook.site/${TOKEN_ID}"

echo ""
echo "  Token ID : $TOKEN_ID"
echo "  Public URL: $WEBHOOK_URL"
echo "  Inspect  : https://webhook.site/#!/view/${TOKEN_ID}"
echo ""

# ── Step 2: Show how to register with Stripe ──────────────────────────────────
echo "To register this URL as a Stripe webhook (run in another terminal):"
echo ""
echo "  stripe webhook-endpoints create \\"
echo "    --url '$WEBHOOK_URL' \\"
echo "    --enabled-events 'customer.created,customer.updated,charge.succeeded'"
echo ""
echo "Or in your sync-engine pipeline config, set:"
echo "  webhook_url: $WEBHOOK_URL"
echo ""

# ── Step 3: Start forwarding ──────────────────────────────────────────────────
echo "Forwarding $WEBHOOK_URL -> $LOCAL_TARGET"
echo "Press Ctrl+C to stop."
echo ""

# WH_API_KEY is optional — omit for free anonymous tokens
exec pnpm exec whcli forward \
  --token="$TOKEN_ID" \
  ${WH_API_KEY:+--api-key="$WH_API_KEY"} \
  --target="$LOCAL_TARGET" \
  --listen-timeout=10
