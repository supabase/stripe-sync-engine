#!/bin/bash
# Publish all non-private workspace packages to $STRIPE_NPM_REGISTRY.
#
# Usage:
#   STRIPE_NPM_REGISTRY=http://localhost:4873 ./scripts/publish-packages.sh
#
# In CI, STRIPE_NPM_REGISTRY is set in the workflow env and auth is added to
# .npmrc before this script runs.

set -euo pipefail

pnpm ls -r --json \
  | jq -r '.[] | select(.private != true) | .name + "@" + .version' \
  | xargs -I{} npm unpublish {} --force 2>/dev/null || true

pnpm publish -r --access public --no-git-checks
