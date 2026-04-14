#!/bin/bash
# Publish all non-private workspace packages to $STRIPE_NPM_REGISTRY.
#
# Usage:
#   STRIPE_NPM_REGISTRY=http://localhost:4873 ./scripts/publish-packages.sh
#
# In CI, STRIPE_NPM_REGISTRY is set in the workflow env and auth is added to
# .npmrc before this script runs.
#
# GitHub Packages returns 409 if the exact version already exists. We treat
# that as a no-op (the version is already published) rather than failing CI.

set -euo pipefail

# Attempt to unpublish existing versions (best-effort, GitHub Packages may reject)
pnpm ls -r --json \
  | jq -r '.[] | select(.private != true) | .name + "@" + .version' \
  | xargs -I{} npm unpublish {} --force 2>/dev/null || true

# Publish — tolerate 409 Conflict (version already exists on GitHub Packages)
pnpm publish -r --access public --no-git-checks 2>&1 | tee /tmp/publish-output.txt || {
  if grep -q 'E409\|Cannot publish over existing version' /tmp/publish-output.txt; then
    echo "::notice::Some packages already existed at this version on the registry (409). Skipping."
  else
    exit 1
  fi
}
