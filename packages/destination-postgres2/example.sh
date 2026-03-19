#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

DB_CONTAINER=stripe-db
DB_USER=postgres
DB_NAME=postgres

# Start postgres (compose.yml at project root)
docker compose up -d postgres
echo "Waiting for postgres..."
until docker exec -T "$DB_CONTAINER" pg_isready -U "$DB_USER" -q 2>/dev/null; do sleep 0.5; done
echo "Postgres ready."

# Run the example
npx tsx packages/destination-postgres2/example.ts

# Show what landed in the database
echo ""
echo "--- customers table ---"
docker exec -T "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c 'SELECT _pk, data FROM customers ORDER BY _pk;'
echo "--- invoices table ---"
docker exec -T "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c 'SELECT _pk, data FROM invoices ORDER BY _pk;'
