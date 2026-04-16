#!/usr/bin/env bash
# Drop all non-system schemas and all tables in public schema.
#
# Usage:
#   ./reset-postgres.sh <database_url>
#   DATABASE_URL=... ./reset-postgres.sh
set -euo pipefail

DATABASE_URL="${1:-${DATABASE_URL:?Usage: reset-postgres.sh <database_url>}}"

echo "Postgres: $DATABASE_URL" >&2

# Drop all non-system schemas (cascades their tables/views)
psql "$DATABASE_URL" -tAc "
  SELECT schema_name FROM information_schema.schemata
  WHERE schema_name NOT IN ('public','information_schema')
    AND schema_name NOT LIKE 'pg_%'
" | while read -r schema; do
  echo "DROP SCHEMA $schema" >&2
  psql "$DATABASE_URL" -c "DROP SCHEMA \"$schema\" CASCADE"
done

# Drop all tables in public schema
psql "$DATABASE_URL" -tAc "
  SELECT tablename FROM pg_tables WHERE schemaname = 'public'
" | while read -r table; do
  echo "DROP TABLE public.$table" >&2
  psql "$DATABASE_URL" -c "DROP TABLE public.\"$table\" CASCADE"
done

echo "Done" >&2
