#!/bin/bash
# Publish all non-private workspace packages to $STRIPE_NPM_REGISTRY.
# Skips packages that are already published; fails on any other error.
#
# Usage:
#   STRIPE_NPM_REGISTRY=http://localhost:4873 ./scripts/publish-packages.sh
#
# In CI, STRIPE_NPM_REGISTRY is set in the workflow env and auth is added to
# .npmrc before this script runs.

set -euo pipefail

REGISTRY="${STRIPE_NPM_REGISTRY:?STRIPE_NPM_REGISTRY must be set}"
echo "Publishing to $REGISTRY"

FAILED=0

for dir in packages/* apps/*; do
  pj="$dir/package.json"
  [ -f "$pj" ] || continue

  # Skip private packages
  grep -q '"private": true' "$pj" && continue

  name=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$pj')). name)")

  printf "  %-55s" "$name"

  output=$(cd "$dir" && npm publish \
    --registry "$REGISTRY" \
    --access public \
    2>&1) && status=0 || status=$?

  if [ $status -eq 0 ]; then
    echo "✓"
  elif echo "$output" | grep -qE "EPUBLISHCONFLICT|E409|already exists|previously published"; then
    echo "already published"
  else
    echo "FAILED"
    echo "$output" >&2
    FAILED=1
  fi
done

exit $FAILED
