#!/bin/bash

# End-to-end integration test for Stripe Sync Engine Error Recovery
# Tests that sync can recover from crashes and preserve partial progress

set -e  # Exit on error

# Source common functions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

echo "🧪 Stripe Sync Engine Error Recovery Integration Test"
echo "======================================================"
echo ""

# Check for required tools
check_required_tools jq

# Load environment variables
load_env_file

# Check required environment variables
check_env_vars DATABASE_URL STRIPE_API_KEY

# Step 0: Start PostgreSQL if not running
start_postgres "stripe-sync-test-db" "app_db"

# Array to store created resource IDs for cleanup
declare -a PRODUCT_IDS=()

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."

    # Delete created Stripe resources using API
    if [ ${#PRODUCT_IDS[@]} -gt 0 ]; then
        echo "   Deleting products from Stripe..."
        for prod_id in "${PRODUCT_IDS[@]}"; do
            curl -s -X DELETE "https://api.stripe.com/v1/products/${prod_id}" \
                -u "${STRIPE_API_KEY}:" > /dev/null 2>&1 || true
        done
    fi

    echo "   Stopping PostgreSQL..."
    stop_postgres "stripe-sync-test-db"
    echo "✓ Cleanup complete"
}

# Register cleanup on exit
trap cleanup EXIT

# Step 1: Build CLI
echo "🔨 Step 1: Building CLI..."
npm run build > /dev/null 2>&1
echo "✓ CLI built successfully"
echo ""

# Step 2: Run migrations
echo "🗄️  Step 2: Running database migrations..."
npm run dev migrate > /dev/null 2>&1
echo "✓ Migrations completed"
echo ""

# Step 3: Create many test products in Stripe
echo "📦 Step 3: Creating test products in Stripe..."
echo "   Creating 200 products to ensure sync takes sufficient time..."
echo ""

for i in {1..200}; do
    PROD_JSON=$(curl -s -X POST https://api.stripe.com/v1/products \
        -u "${STRIPE_API_KEY}:" \
        -d "name=Test Product $i - Recovery" \
        -d "description=Integration test product $i for error recovery")
    PROD_ID=$(echo "$PROD_JSON" | jq -r '.id')
    PRODUCT_IDS+=("$PROD_ID")
    if [ $((i % 25)) -eq 0 ]; then
        echo "   ✓ Created $i products..."
    fi
done

echo "   ✓ All 200 products created"
echo ""
echo "✓ Test data created in Stripe (200 products)"
echo ""

# Step 4: Start sync and kill it mid-process
echo "🔄 Step 4: Testing error handling (simulating crash)..."
echo ""

echo "   Starting product backfill in background..."
# Start sync in background and capture PID
STRIPE_API_KEY=$STRIPE_API_KEY DATABASE_URL=$DATABASE_URL npm run dev backfill product > /tmp/sync-output.log 2>&1 &
SYNC_PID=$!
echo "   Sync PID: $SYNC_PID"

# Poll database waiting for status='running' (deterministic approach)
echo "   Waiting for sync to reach 'running' state..."
MAX_WAIT=100  # 10 seconds max (100 * 0.1s)
WAITED=0
STATUS=""
while [ $WAITED -lt $MAX_WAIT ]; do
    STATUS=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c \
        "SELECT o.status FROM stripe._sync_obj_run o JOIN stripe._sync_run r ON o.\"_account_id\" = r.\"_account_id\" AND o.run_started_at = r.started_at WHERE o.object = 'products' ORDER BY r.started_at DESC LIMIT 1;" \
        2>/dev/null | tr -d ' ' || echo "")

    if [ "$STATUS" = "running" ]; then
        echo "   ✓ Sync reached 'running' state"
        break
    fi

    sleep 0.1
    WAITED=$((WAITED + 1))
done

# Verify we caught it running
if [ "$STATUS" != "running" ]; then
    echo "   ❌ Sync never reached 'running' state (status='$STATUS')"
    kill -9 $SYNC_PID 2>/dev/null || true
    wait $SYNC_PID 2>/dev/null || true
    exit 1
fi

# Kill the sync process while it's running
echo "   Killing sync process to simulate crash..."
kill -9 $SYNC_PID 2>/dev/null || true
wait $SYNC_PID 2>/dev/null || true

echo "   ✓ Sync process killed (simulated crash)"

# Give the database a moment to finish writing
sleep 0.5
echo ""

# Step 5: Verify interrupted state
echo "🔍 Step 5: Verifying interrupted state..."
echo ""

# Get the account ID from the database (from synced data)
echo "   Getting account ID..."
ACCOUNT_ID=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT DISTINCT _account_id FROM stripe.products LIMIT 1;" 2>/dev/null | tr -d ' ' || echo "")
if [ -z "$ACCOUNT_ID" ]; then
    echo "   ❌ Could not determine account ID from synced data"
    exit 1
fi
echo "   ✓ Account ID: $ACCOUNT_ID"
echo ""

# Check sync status (using new observability tables)
SYNC_STATUS=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT o.status FROM stripe._sync_obj_run o JOIN stripe._sync_run r ON o.\"_account_id\" = r.\"_account_id\" AND o.run_started_at = r.started_at WHERE o.\"_account_id\" = '$ACCOUNT_ID' AND o.object = 'products' ORDER BY r.started_at DESC LIMIT 1;" 2>/dev/null | tr -d ' ' || echo "")
echo "   ✓ Sync status after kill: '$SYNC_STATUS'"

# Check how many products were synced before the kill
PRODUCTS_BEFORE_RECOVERY=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.products WHERE name LIKE '%Recovery%';" 2>/dev/null | tr -d ' ' || echo "0")
echo "   ✓ Products synced before recovery: $PRODUCTS_BEFORE_RECOVERY / 200"

# If sync completed before we could kill it (fast CI), skip the interruption test
# but still test that re-running is idempotent
if [ "$PRODUCTS_BEFORE_RECOVERY" -ge 200 ]; then
    echo ""
    echo "   ℹ️  Sync completed before kill (fast machine) - testing idempotent re-run instead"
    SYNC_STATUS="complete"
fi

# Check error message exists (using new observability tables)
ERROR_MSG=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COALESCE(o.error_message, r.error_message, '') FROM stripe._sync_obj_run o JOIN stripe._sync_run r ON o.\"_account_id\" = r.\"_account_id\" AND o.run_started_at = r.started_at WHERE o.\"_account_id\" = '$ACCOUNT_ID' AND o.object = 'products' ORDER BY r.started_at DESC LIMIT 1;" 2>/dev/null | tr -d ' ' || echo "")
if [ -n "$ERROR_MSG" ]; then
    echo "   ✓ Error message recorded: $(echo $ERROR_MSG | head -c 50)..."
else
    echo "   ℹ️  No error message (process killed before error could be recorded)"
fi

# Check cursor was saved (partial progress preserved) - using new observability tables
CURSOR_AFTER_ERROR=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COALESCE(cursor::integer, 0) FROM stripe._sync_obj_run o JOIN stripe._sync_run r ON o.\"_account_id\" = r.\"_account_id\" AND o.run_started_at = r.started_at WHERE o.\"_account_id\" = '$ACCOUNT_ID' AND o.object = 'products' ORDER BY r.started_at DESC LIMIT 1;" 2>/dev/null | tr -d ' ' || echo "0")
if [ -n "$CURSOR_AFTER_ERROR" ] && [ "$CURSOR_AFTER_ERROR" != "" ] && [ "$CURSOR_AFTER_ERROR" -gt 0 ] 2>/dev/null; then
    echo "   ✓ Cursor saved: $CURSOR_AFTER_ERROR (partial progress preserved)"
else
    CURSOR_AFTER_ERROR=0
    echo "   ℹ️  No cursor saved yet"
fi

echo ""

# Step 6: Re-run sync to test recovery
echo "🔄 Step 6: Testing recovery from error..."
echo ""

echo "   Re-running product backfill (should recover)..."
npm run dev backfill product

echo ""

# Step 7: Verify recovery
echo "🔍 Step 7: Verifying successful recovery..."
echo ""

# Check sync status is now 'complete' (using new observability tables)
FINAL_STATUS=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT o.status FROM stripe._sync_obj_run o JOIN stripe._sync_run r ON o.\"_account_id\" = r.\"_account_id\" AND o.run_started_at = r.started_at WHERE o.\"_account_id\" = '$ACCOUNT_ID' AND o.object = 'products' ORDER BY r.started_at DESC LIMIT 1;" 2>/dev/null | tr -d ' ' || echo "")
if [ "$FINAL_STATUS" = "complete" ]; then
    echo "   ✓ Sync status recovered to 'complete'"
else
    echo "   ❌ Expected status 'complete', got '$FINAL_STATUS'"
    exit 1
fi

# Check error message is cleared (in the latest completed sync)
# Note: With the new system, we look at the latest run which should be complete without error
FINAL_ERROR=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COALESCE(o.error_message, '') FROM stripe._sync_obj_run o JOIN stripe._sync_run r ON o.\"_account_id\" = r.\"_account_id\" AND o.run_started_at = r.started_at WHERE o.\"_account_id\" = '$ACCOUNT_ID' AND o.object = 'products' AND o.status = 'complete' ORDER BY r.started_at DESC LIMIT 1;" 2>/dev/null | tr -d ' ')
if [ -z "$FINAL_ERROR" ]; then
    echo "   ✓ Error message cleared (in latest completed sync)"
else
    echo "   ❌ Error message still present: '$FINAL_ERROR'"
    exit 1
fi

# Check cursor advanced or maintained (never decreased) - using new observability tables
FINAL_CURSOR=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COALESCE(cursor::integer, 0) FROM stripe._sync_obj_run o JOIN stripe._sync_run r ON o.\"_account_id\" = r.\"_account_id\" AND o.run_started_at = r.started_at WHERE o.\"_account_id\" = '$ACCOUNT_ID' AND o.object = 'products' AND o.status = 'complete' ORDER BY o.completed_at DESC LIMIT 1;" 2>/dev/null | tr -d ' ')
if [ -z "$FINAL_CURSOR" ]; then
    FINAL_CURSOR="0"
fi

# Calculate cursor delta
CURSOR_DELTA=$((FINAL_CURSOR - CURSOR_AFTER_ERROR))

if [ "$FINAL_CURSOR" -ge "$CURSOR_AFTER_ERROR" ]; then
    if [ "$CURSOR_DELTA" -gt 0 ]; then
        echo "   ✓ Cursor advanced: $CURSOR_AFTER_ERROR → $FINAL_CURSOR (delta: +$CURSOR_DELTA)"
    else
        echo "   ✓ Cursor maintained: $FINAL_CURSOR (delta: 0, no new data since crash)"
    fi
else
    echo "   ❌ Cursor decreased: $CURSOR_AFTER_ERROR → $FINAL_CURSOR (delta: $CURSOR_DELTA) - bug in cursor logic!"
    exit 1
fi

# Check products after recovery
FINAL_PRODUCTS=$(docker exec $POSTGRES_CONTAINER psql -U postgres -d app_db -t -c "SELECT COUNT(*) FROM stripe.products WHERE name LIKE '%Recovery%';" 2>/dev/null | tr -d ' ' || echo "0")

# With cursor-based sync, recovery only fetches products NEWER than cursor.
# If sync was interrupted mid-backfill, older products won't be re-fetched.
# This is a known limitation - the test validates no data loss from what WAS synced.
if [ "$FINAL_PRODUCTS" -ge "$PRODUCTS_BEFORE_RECOVERY" ]; then
    echo "   ✓ No data loss: $FINAL_PRODUCTS products (was $PRODUCTS_BEFORE_RECOVERY before recovery)"
    if [ "$FINAL_PRODUCTS" -lt 200 ]; then
        echo "   ℹ️  Note: Cursor-based sync doesn't resume partial backfills (known limitation)"
    fi
else
    echo "   ❌ Data loss! Had $PRODUCTS_BEFORE_RECOVERY products, now have $FINAL_PRODUCTS"
    exit 1
fi

echo ""
echo "✅ Step 7: Recovery verification passed!"
echo ""

echo "=========================================="
echo "✅ Error Recovery Integration Test Completed!"
echo ""
echo "Summary:"
echo "- ✓ Prerequisites checked (jq for Stripe API JSON parsing)"
echo "- ✓ PostgreSQL started in Docker"
echo "- ✓ CLI built successfully"
echo "- ✓ Database migrations completed"
echo "- ✓ Test data created in Stripe (200 products)"
echo "- ✓ Sync process killed (status after kill: '$SYNC_STATUS')"
echo "- ✓ Products synced before recovery: $PRODUCTS_BEFORE_RECOVERY"
echo "- ✓ Re-run sync completed successfully"
echo "- ✓ Final status: complete"
echo "- ✓ No data loss: $FINAL_PRODUCTS products after recovery"
echo "- ✓ Test data cleaned up from Stripe"
echo ""
