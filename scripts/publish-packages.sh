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

pnpm -r run --if-present unpublish 2>/dev/null || true

pnpm publish -r \
  --registry "$REGISTRY" \
  --access public \
  --no-git-checks
