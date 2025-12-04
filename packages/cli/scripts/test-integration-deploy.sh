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

    # Delete Stripe webhook if we created one
    if [ -n "$WEBHOOK_ID" ]; then
        echo "   Deleting Stripe webhook: $WEBHOOK_ID"
        curl -s -X DELETE "https://api.stripe.com/v1/webhook_endpoints/$WEBHOOK_ID" \
            -u "$STRIPE_API_KEY:" > /dev/null 2>&1 || echo "   Warning: Failed to delete webhook"
    fi

    # Delete Edge Functions
    for func in stripe-setup stripe-webhook stripe-scheduler stripe-worker; do
        echo "   Deleting Edge Function: $func"
        curl -s -X DELETE "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/functions/$func" \
            -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" > /dev/null 2>&1 || true
    done

    # Drop stripe schema
    echo "   Dropping stripe schema..."
    curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"query": "DROP SCHEMA IF EXISTS stripe CASCADE"}' > /dev/null 2>&1 || true

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
SCHEDULER_FUNC=$(echo "$FUNCTIONS" | jq -r '.[] | select(.slug == "stripe-scheduler") | .slug')
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

if [ "$SCHEDULER_FUNC" = "stripe-scheduler" ]; then
    echo "✓ stripe-scheduler function deployed"
else
    echo "❌ stripe-scheduler function NOT found"
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

# Verify pg_cron job (may not exist if pg_cron extension not available)
echo "🔍 Verifying pg_cron job..."
CRON_QUERY="SELECT jobname FROM cron.job WHERE jobname = 'stripe-sync-scheduler'"
CRON_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$CRON_QUERY\"}" 2>/dev/null || echo "[]")

if echo "$CRON_RESULT" | jq -e '.[] | select(.jobname == "stripe-sync-scheduler")' > /dev/null 2>&1; then
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
echo "   Waiting for backfill to sync pre-existing customer (up to 30s)..."
BACKFILL_SUCCESS=false
for i in {1..15}; do
    sleep 2

    # Check if backfill customer exists in database
    BACKFILL_QUERY="SELECT id FROM stripe.customers WHERE id = '$BACKFILL_CUSTOMER_ID'"
    BACKFILL_RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"query\": \"$BACKFILL_QUERY\"}")

    if echo "$BACKFILL_RESULT" | jq -e ".[0].id == \"$BACKFILL_CUSTOMER_ID\"" > /dev/null 2>&1; then
        BACKFILL_SUCCESS=true
        break
    fi
done

if [ "$BACKFILL_SUCCESS" = true ]; then
    echo "   ✓ Pre-existing customer synced via backfill"
else
    echo "   ❌ Pre-existing customer NOT synced via backfill after 30s"
    echo "   This could mean:"
    echo "   - Worker function failed to process"
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
echo "  - Edge Functions: stripe-setup, stripe-webhook, stripe-scheduler, stripe-worker"
echo "  - Stripe webhook: $WEBHOOK_ID"
echo "  - Database schema: stripe.*"
echo ""
echo "Verified functionality:"
echo "  ✓ Backfill syncs pre-existing Stripe data to database"
echo "  ✓ Webhook syncs new Stripe events to database in real-time"
echo ""
echo "Note: Resources will be deleted during cleanup"
