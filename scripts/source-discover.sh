#!/usr/bin/env bash
set -euo pipefail

# Run a source_discover call against the sync engine HTTP API and pretty-print
# the NDJSON response.
#
# Required env:
#   STRIPE_API_KEY   — Stripe secret or restricted key
#
# Optional env:
#   ENGINE_URL       — base URL of the engine (default: http://localhost:3001)
#   API_VERSION      — Stripe API version (default: 2026-03-25.dahlia)

: "${STRIPE_API_KEY:?STRIPE_API_KEY is required}"

ENGINE_URL="${ENGINE_URL:-http://localhost:3001}"
API_VERSION="${API_VERSION:-2026-03-25.dahlia}"

curl -sS --no-buffer \
  -X POST "${ENGINE_URL}/source_discover" \
  -H "Content-Type: application/json" \
  -d "{
    \"source\": {
      \"type\": \"stripe\",
      \"stripe\": {
        \"api_key\": \"${STRIPE_API_KEY}\",
        \"api_version\": \"${API_VERSION}\"
      }
    }
  }" | while IFS= read -r line; do
    echo "${line}" | jq .
  done
