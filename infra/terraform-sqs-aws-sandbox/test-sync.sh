#!/usr/bin/env bash
set -euo pipefail

# Test the real sync engine ECS service against the provisioned RDS.
# Requires: STRIPE_API_KEY env var, terraform outputs available.

cd "$(dirname "$0")"

SYNC_URL="$(terraform output -raw real_sync_engine_url)"
DB_URL="$(terraform output -raw db_connection_string)"

echo "==> Sync engine: $SYNC_URL"
echo "==> RDS: $(terraform output -raw db_endpoint)"

# ── Health check ──────────────────────────────────────────────
echo ""
echo "==> Health check"
curl -sf "$SYNC_URL/health" | jq .

# ── Build params ──────────────────────────────────────────────
PARAMS=$(jq -cn \
  --arg sk "${STRIPE_API_KEY:?Set STRIPE_API_KEY}" \
  --arg db "$DB_URL" \
  '{
    source_config: { api_key: $sk },
    destination_name: "postgres",
    destination_config: { url: ($db + "?sslmode=no-verify"), schema: "public" },
    streams: [
      { name: "products", sync_mode: "full_refresh" },
      { name: "customers", sync_mode: "full_refresh" }
    ]
  }')

# ── Setup destination ─────────────────────────────────────────
echo ""
echo "==> Setting up destination tables"
curl -sf -X POST "$SYNC_URL/setup" -H "X-Sync-Params: $PARAMS"
echo "OK (204)"

# ── Run sync ──────────────────────────────────────────────────
echo ""
echo "==> Running sync (Stripe → Postgres) — this may take a few minutes"
curl -sN -X POST --max-time 600 "$SYNC_URL/run" \
  -H "X-Sync-Params: $PARAMS" || true

# ── Verify data landed ────────────────────────────────────────
echo ""
echo "==> Verifying data in Postgres"
psql "$DB_URL?sslmode=require" <<'SQL'
SELECT 'products' AS "table", count(*) FROM public.products
UNION ALL
SELECT 'customers', count(*) FROM public.customers;
SQL

echo ""
echo "==> Sample products"
psql "$DB_URL?sslmode=require" -c "SELECT id, name FROM public.products LIMIT 5;"

echo ""
echo "Done."
