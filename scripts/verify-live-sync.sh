#!/usr/bin/env bash
set -euo pipefail

# Verify live sync: create, update, and delete a Stripe product and assert
# that each change propagates to the Stripe database within a few seconds.
#
# Required env: STRIPE_API_KEY, DB_STRING, STRIPE_API_BASE

: "${STRIPE_API_KEY:?STRIPE_API_KEY is required}"
: "${DB_STRING:?DB_STRING is required}"
STRIPE_FLAGS="--api-base ${STRIPE_API_BASE:?STRIPE_API_BASE is required}"

POLL_INTERVAL=2
POLL_TIMEOUT=30  # seconds

RUN_TAG="e2e-$(date +%s)"
UPDATED_NAME="${RUN_TAG}-updated"

# Poll the DB until $SQL returns $EXPECTED, or fail after POLL_TIMEOUT seconds.
poll_db() {
  local description="$1"
  local sql="$2"
  local expected="$3"
  local elapsed=0
  local result

  echo "Waiting for: $description"
  while [ "$elapsed" -lt "$POLL_TIMEOUT" ]; do
    result=$(psql "$DB_STRING" -t -A -c "$sql" 2>/dev/null || echo "")
    if [ "$result" = "$expected" ]; then
      echo "  confirmed in ${elapsed}s"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  echo "::error::Timed out after ${POLL_TIMEOUT}s waiting for: $description (last='$result')"
  return 1
}

# After a delete, the row may be removed entirely or marked deleted=true.
# Accept either outcome.
poll_deletion() {
  local product_id="$1"
  local elapsed=0
  local result

  echo "Waiting for: product $product_id deletion reflected in DB"
  while [ "$elapsed" -lt "$POLL_TIMEOUT" ]; do
    result=$(psql "$DB_STRING" -t -A -c \
      "SELECT COALESCE(_raw_data->>'deleted', 'false') FROM public.products WHERE id = '$product_id' LIMIT 1" \
      2>/dev/null || echo "")
    # Row gone (empty) or explicitly marked deleted
    if [ -z "$result" ] || [ "$result" = "true" ]; then
      echo "  confirmed deletion in ${elapsed}s"
      return 0
    fi
    sleep "$POLL_INTERVAL"
    elapsed=$((elapsed + POLL_INTERVAL))
  done
  echo "::error::Timed out after ${POLL_TIMEOUT}s waiting for deletion of $product_id (last='$result')"
  return 1
}

# ---------------------------------------------------------------------------
# Step 1: Create
# ---------------------------------------------------------------------------
echo ""
echo "=== Live sync: create ==="
CREATE_OUTPUT=$(stripe products create --name "$RUN_TAG" $STRIPE_FLAGS 2>&1)
PRODUCT_ID=$(echo "$CREATE_OUTPUT" | jq -r '.id // empty' 2>/dev/null || \
             echo "$CREATE_OUTPUT" | grep -oE '"id": "prod_[A-Za-z0-9]+"' | grep -oE 'prod_[A-Za-z0-9]+' | head -1)

if [ -z "$PRODUCT_ID" ]; then
  echo "::error::Failed to extract product ID from create output"
  exit 1
fi
echo "Created: $PRODUCT_ID (name=$RUN_TAG)"

poll_db \
  "product $PRODUCT_ID appears in DB" \
  "SELECT id FROM public.products WHERE id = '$PRODUCT_ID' LIMIT 1" \
  "$PRODUCT_ID"

# ---------------------------------------------------------------------------
# Step 2: Update
# ---------------------------------------------------------------------------
echo ""
echo "=== Live sync: update ==="
stripe products update "$PRODUCT_ID" --name "$UPDATED_NAME" $STRIPE_FLAGS >/dev/null
echo "Updated: $PRODUCT_ID name → $UPDATED_NAME"

poll_db \
  "name update reflected in DB" \
  "SELECT _raw_data->>'name' FROM public.products WHERE id = '$PRODUCT_ID' LIMIT 1" \
  "$UPDATED_NAME"

# ---------------------------------------------------------------------------
# Step 3: Delete
# ---------------------------------------------------------------------------
echo ""
echo "=== Live sync: delete ==="
stripe products delete "$PRODUCT_ID" $STRIPE_FLAGS >/dev/null
echo "Deleted: $PRODUCT_ID"

poll_deletion "$PRODUCT_ID"

echo ""
echo "Live sync verification passed: create → update → delete all propagated within ${POLL_TIMEOUT}s"
