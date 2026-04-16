# Sourced by step scripts — defines connector aliases only.
# ROOT must be set by the sourcing script before sourcing this file.

set -euo pipefail
[ -f "$ROOT/.env" ] && set -a && source "$ROOT/.env" && set +a

source-stripe() { "$ROOT/scripts/ts-run" "$ROOT/packages/source-stripe/src/bin.ts" "$@"; }
dest-postgres()  { "$ROOT/scripts/ts-run" "$ROOT/packages/destination-postgres/src/bin.ts" "$@"; }
