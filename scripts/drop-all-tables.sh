#!/usr/bin/env bash
# Drop all tables and functions in the public schema of a given Postgres database.
# Idempotent — safe to run multiple times.
# Usage: ./scripts/drop-all-tables.sh <database_url>

set -euo pipefail

DB_URL="${1:?Usage: $0 <database_url>}"

psql "$DB_URL" -t -A -c "
  SELECT 'DROP TABLE IF EXISTS \"' || tablename || '\" CASCADE;'
  FROM pg_tables WHERE schemaname = 'public';

  SELECT 'DROP FUNCTION IF EXISTS \"' || routine_name || '\" CASCADE;'
  FROM information_schema.routines WHERE routine_schema = 'public';
" | psql "$DB_URL"

echo "Done. Public schema is clean."
