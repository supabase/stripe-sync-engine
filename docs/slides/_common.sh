# Sourced by step scripts — defines connector aliases only.
# ROOT must be set by the sourcing script before sourcing this file.

set -euo pipefail
[ -f "$ROOT/.env" ] && set -a && source "$ROOT/.env" && set +a

source-stripe() { node "$ROOT/packages/source-stripe/dist/bin.js" "$@"; }
dest-postgres()  { node "$ROOT/packages/destination-postgres/dist/bin.js" "$@"; }
