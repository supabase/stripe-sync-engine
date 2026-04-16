#!/usr/bin/env bash
# Drop all tables and functions in the public schema of a given Postgres database.
# Preserves the schema itself, its permissions, and any installed extensions.
# Idempotent — safe to run multiple times.
# Usage: ./scripts/drop-all-tables.sh <database_url>

set -euo pipefail

DB_URL="${1:?Usage: $0 <database_url>}"

SQL=$(psql "$DB_URL" -t -A -c "
  SELECT string_agg('DROP TABLE IF EXISTS public.\"' || tablename || '\" CASCADE', ';')
  FROM pg_tables WHERE schemaname = 'public';
")

if [ -n "$SQL" ] && [ "$SQL" != "" ]; then
  psql "$DB_URL" -c "$SQL;"
  echo "Dropped all tables in public schema."
else
  echo "No tables to drop."
fi

# Drop functions
FSQL=$(psql "$DB_URL" -t -A -c "
  SELECT string_agg('DROP FUNCTION IF EXISTS public.\"' || p.proname || '\"(' || pg_get_function_identity_arguments(p.oid) || ') CASCADE', ';')
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public';
")

if [ -n "$FSQL" ] && [ "$FSQL" != "" ]; then
  psql "$DB_URL" -c "$FSQL;"
  echo "Dropped all functions in public schema."
fi

echo "Done. Public schema is clean."
