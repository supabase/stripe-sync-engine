#!/bin/bash
set -euo pipefail

# Cleanup script for demo - removes all deployed resources
# Run this before `node dist/index.js deploy` to start fresh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_DIR="$(dirname "$SCRIPT_DIR")"

source "$SCRIPT_DIR/common.sh"

echo "================================================"
echo "  Stripe Sync - Cleanup Deploy"
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
check_required_tools curl jq

# Check required environment variables
check_env_vars SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_REF STRIPE_API_KEY

echo "🔍 Checking existing resources..."
echo ""

# Get managed webhook IDs from database
echo "🔗 Stripe Webhooks (from stripe._managed_webhooks):"
MANAGED_WEBHOOKS=$(curl -s --max-time 10 -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"query": "SELECT webhook_id, webhook_url FROM stripe._managed_webhooks"}' 2>/dev/null || echo "[]")

# Check if response is an array (success) or object (error)
if echo "$MANAGED_WEBHOOKS" | jq -e 'type == "array"' > /dev/null 2>&1; then
    WEBHOOK_IDS=$(echo "$MANAGED_WEBHOOKS" | jq -r '.[].webhook_id // empty' 2>/dev/null)
else
    WEBHOOK_IDS=""
fi

if [ -n "$WEBHOOK_IDS" ]; then
    for row in $(echo "$MANAGED_WEBHOOKS" | jq -c '.[]' 2>/dev/null); do
        WH_ID=$(echo "$row" | jq -r '.webhook_id')
        WH_URL=$(echo "$row" | jq -r '.webhook_url')
        echo "   ✓ Found: $WH_ID"
        echo "     URL: $WH_URL"
    done
else
    echo "   (none)"
fi

# Check Edge Functions
echo ""
echo "⚡ Edge Functions:"
FUNCTIONS=$(curl -s --fail -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/functions") || {
    echo "   ✗ Failed to fetch edge functions"
    FUNCTIONS="[]"
}
for func in stripe-setup stripe-webhook stripe-scheduler stripe-worker; do
    if echo "$FUNCTIONS" | jq -e --arg slug "$func" '.[] | select(.slug == $slug)' > /dev/null 2>&1; then
        echo "   ✓ Found: $func"
    else
        echo "   - Not found: $func"
    fi
done

# Check pg_cron job
echo ""
echo "⏰ pg_cron Job:"
CRON_RESULT=$(curl -s --max-time 10 -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"query": "SELECT jobname FROM cron.job WHERE jobname = '"'"'stripe-sync-scheduler'"'"'"}' 2>/dev/null || echo "[]")
if echo "$CRON_RESULT" | jq -e 'type == "array" and .[0].jobname' > /dev/null 2>&1; then
    echo "   ✓ Found: stripe-sync-scheduler"
else
    echo "   (none)"
fi

# Check stripe schema
echo ""
echo "🗄️  Database Schema:"
SCHEMA_RESULT=$(curl -s --max-time 10 -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"query": "SELECT schema_name FROM information_schema.schemata WHERE schema_name = '"'"'stripe'"'"'"}' 2>/dev/null || echo "[]")
if echo "$SCHEMA_RESULT" | jq -e 'type == "array" and .[0].schema_name' > /dev/null 2>&1; then
    echo "   ✓ Found: stripe schema"
    # Count tables
    TABLES_RESULT=$(curl -s --max-time 10 -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
        -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"query": "SELECT table_name FROM information_schema.tables WHERE table_schema = '"'"'stripe'"'"'"}' 2>/dev/null || echo "[]")
    if echo "$TABLES_RESULT" | jq -e 'type == "array"' > /dev/null 2>&1; then
        TABLE_COUNT=$(echo "$TABLES_RESULT" | jq 'length')
        echo "   ✓ Tables: $TABLE_COUNT"
    else
        echo "   ✗ Failed to count tables"
    fi
else
    echo "   (none)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🧹 Deleting resources..."
echo ""

# Delete Stripe webhooks
if [ -n "$WEBHOOK_IDS" ]; then
    for WEBHOOK_ID in $WEBHOOK_IDS; do
        echo "   Deleting webhook: $WEBHOOK_ID"
        curl -s -X DELETE "https://api.stripe.com/v1/webhook_endpoints/$WEBHOOK_ID" \
            -u "$STRIPE_API_KEY:" > /dev/null 2>&1 || echo "   Warning: Failed to delete webhook"
    done
fi

# Delete Edge Functions
for func in stripe-setup stripe-webhook stripe-scheduler stripe-worker; do
    if echo "$FUNCTIONS" | jq -e --arg slug "$func" '.[] | select(.slug == $slug)' > /dev/null 2>&1; then
        echo "   Deleting function: $func"
        if curl -s --fail -X DELETE "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/functions/$func" \
            -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" > /dev/null 2>&1; then
            echo "   ✓ Deleted: $func"
        else
            echo "   ✗ Failed to delete: $func"
        fi
    fi
done

# Delete pg_cron job and vault secret
echo "   Deleting pg_cron job..."
curl -s --max-time 10 -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"query": "SELECT cron.unschedule('"'"'stripe-sync-scheduler'"'"') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = '"'"'stripe-sync-scheduler'"'"')"}' > /dev/null 2>&1 || true

echo "   Deleting vault secret..."
curl -s --max-time 10 -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"query": "DELETE FROM vault.secrets WHERE name = '"'"'stripe_sync_service_role_key'"'"'"}' > /dev/null 2>&1 || true

# Drop stripe schema
echo "   Dropping stripe schema..."
curl -s --max-time 10 -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"query": "DROP SCHEMA IF EXISTS stripe CASCADE"}' > /dev/null 2>&1 || true

echo ""
echo "================================================"
echo "✅ Cleanup complete!"
echo "================================================"
echo ""
echo "You can now run a fresh deploy:"
echo "  node dist/index.js deploy"
echo ""
