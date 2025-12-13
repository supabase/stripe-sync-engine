#!/bin/bash
set -euo pipefail

# Integration test for the deploy command
# Tests the full Supabase deployment flow with real services

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_DIR="$(dirname "$SCRIPT_DIR")"

source "$SCRIPT_DIR/common.sh"

echo "================================================"
echo "  Stripe Sync - Deploy Integration Test"
echo "================================================"
echo ""

# Load .env file if it exists
if [ -f "$CLI_DIR/.env" ]; then
    echo "📄 Loading environment from .env file..."
    set -a
    source "$CLI_DIR/.env"
    set +a
    echo ""
fi

# Check prerequisites
check_required_tools curl jq node

# Check required environment variables (no DB password needed!)
check_env_vars SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_REF STRIPE_API_KEY

# Track IDs for cleanup
WEBHOOK_ID=""
TEST_CUSTOMER_ID=""
BACKFILL_CUSTOMER_ID=""

# Cleanup function
cleanup() {
    echo ""
    echo "🧹 Cleaning up..."

    # Delete test customers if we created them
    if [ -n "$TEST_CUSTOMER_ID" ]; then
        echo "   Deleting webhook test customer: $TEST_CUSTOMER_ID"
        curl -s -X DELETE "https://api.stripe.com/v1/customers/$TEST_CUSTOMER_ID" \
            -u "$STRIPE_API_KEY:" > /dev/null 2>&1 || echo "   Warning: Failed to delete test customer"
    fi

    if [ -n "$BACKFILL_CUSTOMER_ID" ]; then
        echo "   Deleting backfill test customer: $BACKFILL_CUSTOMER_ID"
        curl -s -X DELETE "https://api.stripe.com/v1/customers/$BACKFILL_CUSTOMER_ID" \
            -u "$STRIPE_API_KEY:" > /dev/null 2>&1 || echo "   Warning: Failed to delete backfill customer"
    fi

    # Use programmatic uninstall command to clean up all deployed resources
    echo "   Running uninstall command..."
    node dist/index.js uninstall \
        --token "$SUPABASE_ACCESS_TOKEN" \
        --project "$SUPABASE_PROJECT_REF" \
        --stripe-key "$STRIPE_API_KEY" > /dev/null 2>&1 || echo "   Warning: Failed to run uninstall"

    # Verify uninstall completed successfully
    echo "   Verifying uninstall..."

    # Check 1: Verify schema is dropped
    SCHEMA_CHECK=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"query": "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = '"'"'stripe'"'"') as schema_exists"}' 2>/dev/null || echo '[]')

    SCHEMA_EXISTS=$(echo "$SCHEMA_CHECK" | jq -r '.[0].schema_exists // true')

    if [ "$SCHEMA_EXISTS" = "false" ]; then
        echo "   ✓ Schema dropped successfully"
    else
        echo "   ⚠ Schema still exists (uninstall may have failed)"
    fi

    # Check 2: Verify Edge Functions are deleted
    FUNCTIONS_CHECK=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/functions" 2>/dev/null || echo '[]')

    SETUP_EXISTS=$(echo "$FUNCTIONS_CHECK" | jq -r '.[] | select(.slug == "stripe-setup") | .slug' 2>/dev/null || echo "")
    WEBHOOK_EXISTS=$(echo "$FUNCTIONS_CHECK" | jq -r '.[] | select(.slug == "stripe-webhook") | .slug' 2>/dev/null || echo "")
    WORKER_EXISTS=$(echo "$FUNCTIONS_CHECK" | jq -r '.[] | select(.slug == "stripe-worker") | .slug' 2>/dev/null || echo "")

    if [ -z "$SETUP_EXISTS" ] && [ -z "$WEBHOOK_EXISTS" ] && [ -z "$WORKER_EXISTS" ]; then
        echo "   ✓ Edge Functions deleted successfully"
    else
        echo "   ⚠ Some Edge Functions still exist (uninstall may have failed)"
    fi

    echo "   Done"
}

# Register cleanup on exit
trap cleanup EXIT

# Build CLI first
echo "📦 Building CLI..."
cd "$CLI_DIR"
pnpm build > /dev/null 2>&1
echo "✓ CLI built"
echo ""

# Create a customer BEFORE deploying (for backfill test - no webhook exists yet)
echo "🧪 Creating backfill test customer (before webhook exists)..."
BACKFILL_CUSTOMER_RESPONSE=$(curl -s -X POST "https://api.stripe.com/v1/customers" \
    -u "$STRIPE_API_KEY:" \
    -d "name=Backfill Test Customer" \
    -d "email=backfill-test-$(date +%s)@example.com" \
    -d "metadata[test]=backfill-integration")

BACKFILL_CUSTOMER_ID=$(echo "$BACKFILL_CUSTOMER_RESPONSE" | jq -r '.id')
if [ -z "$BACKFILL_CUSTOMER_ID" ] || [ "$BACKFILL_CUSTOMER_ID" = "null" ]; then
    echo "❌ Failed to create backfill test customer"
    echo "   Response: $BACKFILL_CUSTOMER_RESPONSE"
    exit 1
fi
echo "✓ Created customer for backfill test: $BACKFILL_CUSTOMER_ID"
echo ""

# Run deploy command (no DB password needed - migrations run via Edge Function)
echo "🚀 Running deploy command..."
node dist/index.js deploy \
    --token "$SUPABASE_ACCESS_TOKEN" \
    --project "$SUPABASE_PROJECT_REF" \
    --stripe-key "$STRIPE_API_KEY"
echo ""

# Verify Edge Functions deployed
echo "🔍 Verifying Edge Functions..."
FUNCTIONS=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/functions")

SETUP_FUNC=$(echo "$FUNCTIONS" | jq -r '.[] | select(.slug == "stripe-setup") | .slug')
WEBHOOK_FUNC=$(echo "$FUNCTIONS" | jq -r '.[] | select(.slug == "stripe-webhook") | .slug')
WORKER_FUNC=$(echo "$FUNCTIONS" | jq -r '.[] | select(.slug == "stripe-worker") | .slug')

if [ "$SETUP_FUNC" = "stripe-setup" ]; then
    echo "✓ stripe-setup function deployed"
else
    echo "❌ stripe-setup function NOT found"
    exit 1
fi

if [ "$WEBHOOK_FUNC" = "stripe-webhook" ]; then
    echo "✓ stripe-webhook function deployed"
else
    echo "❌ stripe-webhook function NOT found"
    exit 1
fi

if [ "$WORKER_FUNC" = "stripe-worker" ]; then
    echo "✓ stripe-worker function deployed"
else
    echo "❌ stripe-worker function NOT found"
    exit 1
fi
echo ""

# Verify Stripe webhook created
echo "🔍 Verifying Stripe webhook..."
WEBHOOKS=$(curl -s -u "$STRIPE_API_KEY:" "https://api.stripe.com/v1/webhook_endpoints")
WEBHOOK_URL="https://$SUPABASE_PROJECT_REF.supabase.co/functions/v1/stripe-webhook"

WEBHOOK_DATA=$(echo "$WEBHOOKS" | jq -r --arg url "$WEBHOOK_URL" '.data[] | select(.url == $url)')

if [ -n "$WEBHOOK_DATA" ]; then
    WEBHOOK_ID=$(echo "$WEBHOOK_DATA" | jq -r '.id')
    WEBHOOK_STATUS=$(echo "$WEBHOOK_DATA" | jq -r '.status')
    echo "✓ Stripe webhook created: $WEBHOOK_ID (status: $WEBHOOK_STATUS)"
else
    echo "❌ Stripe webhook NOT found for URL: $WEBHOOK_URL"
    exit 1
fi
echo ""

# Verify database schema using Supabase Management API
echo "🔍 Verifying database schema..."
TABLES_QUERY="SELECT table_name FROM information_schema.tables WHERE table_schema = 'stripe' ORDER BY table_name"
TABLES_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$TABLES_QUERY\"}")

if echo "$TABLES_RESULT" | jq -e '.[] | select(.table_name == "customers")' > /dev/null 2>&1; then
    echo "✓ stripe.customers table exists"
else
    echo "❌ stripe.customers table NOT found"
    echo "   Response: $TABLES_RESULT"
    exit 1
fi

if echo "$TABLES_RESULT" | jq -e '.[] | select(.table_name == "_managed_webhooks")' > /dev/null 2>&1; then
    echo "✓ stripe._managed_webhooks table exists"
else
    echo "❌ stripe._managed_webhooks table NOT found"
    exit 1
fi
echo ""

# Verify installation status (tests SupabaseDeployClient.isInstalled() logic)
echo "🔍 Verifying installation status..."

# Check 1: Verify migrations table exists
MIGRATIONS_TABLE_QUERY="SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'stripe' AND table_name IN ('migrations', '_migrations')) as table_exists"
MIGRATIONS_TABLE_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$MIGRATIONS_TABLE_QUERY\"}")

MIGRATIONS_TABLE_EXISTS=$(echo "$MIGRATIONS_TABLE_RESULT" | jq -r '.[0].table_exists // false')

if [ "$MIGRATIONS_TABLE_EXISTS" = "true" ]; then
    echo "✓ Migrations table exists"
else
    echo "❌ Migrations table NOT found"
    exit 1
fi

# Check 2: Verify schema comment (installation marker)
COMMENT_QUERY="SELECT obj_description(oid, 'pg_namespace') as comment FROM pg_namespace WHERE nspname = 'stripe'"
COMMENT_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$COMMENT_QUERY\"}")

SCHEMA_COMMENT=$(echo "$COMMENT_RESULT" | jq -r '.[0].comment // empty')

if [ -n "$SCHEMA_COMMENT" ] && echo "$SCHEMA_COMMENT" | grep -q "stripe-sync.*installed"; then
    echo "✓ Schema comment set: $SCHEMA_COMMENT"
else
    echo "❌ Schema comment NOT set correctly"
    echo "   Expected: 'stripe-sync v{version} installed'"
    echo "   Got: '$SCHEMA_COMMENT'"
    exit 1
fi

# All isInstalled() checks passed
echo "✓ Installation verification complete (isInstalled() would return true)"
echo ""

# Verify pg_cron job (may not exist if pg_cron extension not available)
echo "🔍 Verifying pg_cron job..."
CRON_QUERY="SELECT jobname FROM cron.job WHERE jobname = 'stripe-sync-worker'"
CRON_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$CRON_QUERY\"}" 2>/dev/null || echo "[]")

if echo "$CRON_RESULT" | jq -e '.[] | select(.jobname == "stripe-sync-worker")' > /dev/null 2>&1; then
    echo "✓ pg_cron job configured"
else
    echo "⚠️  pg_cron job NOT found (pg_cron extension may not be enabled)"
fi
echo ""

# Get service role key for invoking Edge Functions
echo "🔑 Getting service role key..."
API_KEYS=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/api-keys")
SERVICE_ROLE_KEY=$(echo "$API_KEYS" | jq -r '.[] | select(.name == "service_role") | .api_key')

if [ -z "$SERVICE_ROLE_KEY" ] || [ "$SERVICE_ROLE_KEY" = "null" ]; then
    echo "❌ Could not get service role key"
    exit 1
fi
echo "✓ Got service role key"
echo ""

# Test 1: Verify backfill syncs the pre-existing customer (created before webhook existed)
echo "🧪 Testing backfill sync..."
echo "   Waiting for initial backfill to complete (up to 10 minutes)..."

# Wait for sync run to complete (closed_at IS NOT NULL)
SYNC_COMPLETE=false
for i in {1..60}; do
    sleep 10

    # Check if sync run is complete
    SYNC_STATUS_QUERY="SELECT closed_at, status FROM stripe.sync_dashboard ORDER BY started_at DESC LIMIT 1"
    SYNC_STATUS_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"query\": \"$SYNC_STATUS_QUERY\"}")

    # Check if result is an array (successful query) or error object
    if echo "$SYNC_STATUS_RESULT" | jq -e 'type == "array"' > /dev/null 2>&1; then
        CLOSED_AT=$(echo "$SYNC_STATUS_RESULT" | jq -r '.[0].closed_at // empty')
        STATUS=$(echo "$SYNC_STATUS_RESULT" | jq -r '.[0].status // "unknown"')
    else
        # Query failed (table doesn't exist yet or other error)
        CLOSED_AT=""
        STATUS="pending"
    fi

    if [ -n "$CLOSED_AT" ] && [ "$CLOSED_AT" != "null" ]; then
        SYNC_COMPLETE=true
        echo "   ✓ Initial backfill completed with status: $STATUS"
        break
    fi

    # Show progress every 30 seconds
    if [ $((i % 3)) -eq 0 ]; then
        echo "   Still running... (${i}0s elapsed, status: $STATUS)"
    fi
done

if [ "$SYNC_COMPLETE" != true ]; then
    echo "   ❌ Backfill did not complete within 10 minutes"
    exit 1
fi

# Now check if customer was synced
echo "   Verifying customer was synced..."
BACKFILL_QUERY="SELECT id FROM stripe.customers WHERE id = '$BACKFILL_CUSTOMER_ID'"
BACKFILL_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$BACKFILL_QUERY\"}")

if echo "$BACKFILL_RESULT" | jq -e ".[0].id == \"$BACKFILL_CUSTOMER_ID\"" > /dev/null 2>&1; then
    echo "   ✓ Pre-existing customer synced via backfill"
else
    echo "   ❌ Pre-existing customer NOT found in database after backfill"
    echo "   This could mean:"
    echo "   - Customer was created in different Stripe account"
    echo "   - Database write failed"
    exit 1
fi
echo ""

# Test 2: Create a NEW customer and verify webhook syncs it
echo "🧪 Testing webhook sync..."
echo "   Creating test customer in Stripe..."
CUSTOMER_RESPONSE=$(curl -s -X POST "https://api.stripe.com/v1/customers" \
    -u "$STRIPE_API_KEY:" \
    -d "name=Webhook Test Customer" \
    -d "email=webhook-test-$(date +%s)@example.com" \
    -d "metadata[test]=webhook-integration")

TEST_CUSTOMER_ID=$(echo "$CUSTOMER_RESPONSE" | jq -r '.id')
if [ -z "$TEST_CUSTOMER_ID" ] || [ "$TEST_CUSTOMER_ID" = "null" ]; then
    echo "❌ Failed to create test customer"
    echo "   Response: $CUSTOMER_RESPONSE"
    exit 1
fi
echo "   ✓ Created customer: $TEST_CUSTOMER_ID"

# Wait for webhook to process (Stripe sends webhooks async)
echo "   Waiting for webhook to sync (up to 30s)..."
WEBHOOK_SUCCESS=false
for i in {1..15}; do
    sleep 2

    # Check if customer exists in database
    CUSTOMER_QUERY="SELECT id FROM stripe.customers WHERE id = '$TEST_CUSTOMER_ID'"
    CUSTOMER_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"query\": \"$CUSTOMER_QUERY\"}")

    if echo "$CUSTOMER_RESULT" | jq -e ".[0].id == \"$TEST_CUSTOMER_ID\"" > /dev/null 2>&1; then
        WEBHOOK_SUCCESS=true
        break
    fi
done

if [ "$WEBHOOK_SUCCESS" = true ]; then
    echo "   ✓ Customer synced via webhook"
else
    echo "   ❌ Customer NOT synced via webhook after 30s"
    echo "   This could mean:"
    echo "   - Webhook is not properly configured"
    echo "   - Edge Function failed to process"
    echo "   - Database write failed"
    exit 1
fi
echo ""

echo "================================================"
echo "✅ Deploy integration test PASSED!"
echo "================================================"
echo ""
echo "Deployed resources:"
echo "  - Edge Functions: stripe-setup, stripe-webhook, stripe-worker"
echo "  - Stripe webhook: $WEBHOOK_ID"
echo "  - Database schema: stripe.*"
echo ""
echo "Verified functionality:"
echo "  ✓ Installation status (migrations table + schema comment)"
echo "  ✓ Backfill syncs pre-existing Stripe data to database"
echo "  ✓ Webhook syncs new Stripe events to database in real-time"
echo ""
echo "Note: Resources will be deleted during cleanup"
