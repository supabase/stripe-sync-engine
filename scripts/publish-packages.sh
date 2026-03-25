#!/bin/bash
# Publish all non-private workspace packages to $STRIPE_NPM_REGISTRY.
#
# Usage:
#   STRIPE_NPM_REGISTRY=http://localhost:4873 ./scripts/publish-packages.sh
#
# In CI, STRIPE_NPM_REGISTRY is set in the workflow env and auth is added to
# .npmrc before this script runs.

set -euo pipefail

REGISTRY="${STRIPE_NPM_REGISTRY:?STRIPE_NPM_REGISTRY must be set}"
echo "Publishing to $REGISTRY"

for dir in packages/* apps/*; do
  pj="$dir/package.json"
  [ -f "$pj" ] || continue
  grep -q '"private": true' "$pj" && continue
  name=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$pj')).name)")
  version=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$pj')).version)")
  npm unpublish "$name@$version" --registry "$REGISTRY" --force 2>/dev/null || true
done

pnpm publish -r \
  --registry "$REGISTRY" \
  --access public \
  --no-git-checks
