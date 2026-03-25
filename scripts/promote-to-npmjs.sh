#!/usr/bin/env bash
#
# Promote @stripe/* packages from GitHub Packages to npmjs.org.
#
# No checkout needed — discovers packages via GitHub API, packs from
# GitHub Packages, and publishes tarballs to npmjs.org.
#
# Required env:
#   GITHUB_TOKEN       — for reading from GitHub Packages + API
#   NPM_TOKEN          — for publishing to npmjs.org
#   GITHUB_REPO_OWNER  — GitHub org (e.g. "stripe")
#   GITHUB_REPO_NAME   — repo name (e.g. "sync-engine")
#
# Usage:
#   bash scripts/promote-to-npmjs.sh
#

set -euo pipefail

: "${GITHUB_TOKEN:?Required}"
: "${NPM_TOKEN:?Required}"
: "${GITHUB_REPO_OWNER:?Required}"
: "${GITHUB_REPO_NAME:?Required}"

WORKDIR=$(mktemp -d)
cd "$WORKDIR"
trap 'rm -rf "$WORKDIR"' EXIT

# Auth for reading from GitHub Packages
echo "@stripe:registry=https://npm.pkg.github.com" > .npmrc
echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> .npmrc

# Discover @stripe/* packages from GitHub Packages API
echo "=== Discovering packages ==="
PACKAGES=$(curl -sf \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/orgs/${GITHUB_REPO_OWNER}/packages?package_type=npm&per_page=100" \
  | node -e "
    const pkgs = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    pkgs.filter(p => p.repository && p.repository.name === '${GITHUB_REPO_NAME}')
        .forEach(p => console.log('@${GITHUB_REPO_OWNER}/' + p.name));
  ")

if [ -z "$PACKAGES" ]; then
  echo "FAIL: no packages found for ${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}"
  exit 1
fi

echo "$PACKAGES"
echo ""

# Pack each package from GitHub Packages
echo "=== Packing from GitHub Packages ==="
for pkg in $PACKAGES; do
  echo "--- $pkg ---"
  npm pack "$pkg" --registry https://npm.pkg.github.com
done

# Publish all tarballs to npmjs.org
echo ""
echo "=== Publishing to npmjs.org ==="
for tgz in *.tgz; do
  echo "Publishing $tgz"
  npm publish "$tgz" \
    --registry https://registry.npmjs.org \
    --access public \
    --//registry.npmjs.org/:_authToken="${NPM_TOKEN}"
done

echo ""
echo "=== Done ==="
