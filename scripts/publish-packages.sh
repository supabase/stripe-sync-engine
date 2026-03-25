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

output=$(pnpm publish -r \
  --registry "$REGISTRY" \
  --access public \
  --no-git-checks \
  2>&1) && status=0 || status=$?

echo "$output"

if [ $status -ne 0 ] && ! echo "$output" | grep -qE "EPUBLISHCONFLICT|E409|already exists|previously published"; then
  exit $status
fi
