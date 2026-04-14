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
# Optional env:
#   RELEASE_VERSION    — exact version to promote instead of the latest package
#
# Usage:
#   bash scripts/promote-to-npmjs.sh
#

set -euo pipefail

: "${GITHUB_TOKEN:?Required}"
: "${NPM_TOKEN:?Required}"
: "${GITHUB_REPO_OWNER:?Required}"
: "${GITHUB_REPO_NAME:?Required}"
RELEASE_VERSION="${RELEASE_VERSION:-}"

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
  | jq -r --arg repo "$GITHUB_REPO_NAME" --arg owner "$GITHUB_REPO_OWNER" \
    '.[] | select(.repository.name == $repo) | "@\($owner)/\(.name)"')

if [ -z "$PACKAGES" ]; then
  echo "FAIL: no packages found for ${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}"
  exit 1
fi

echo "$PACKAGES"
echo ""

# Pack each package from GitHub Packages
echo "=== Packing from GitHub Packages ==="
PACK_FAILURES=0
for pkg in $PACKAGES; do
  echo "--- $pkg ---"
  package_spec="$pkg"
  if [ -n "$RELEASE_VERSION" ]; then
    package_spec="${pkg}@${RELEASE_VERSION}"
  fi
  if ! npm pack "$package_spec" --registry https://npm.pkg.github.com 2>&1; then
    echo "WARNING: failed to pack $package_spec — skipping (stale or missing version)"
    PACK_FAILURES=$((PACK_FAILURES + 1))
  fi
done

# Publish all tarballs to npmjs.org
echo ""
echo "=== Publishing to npmjs.org ==="
ALREADY_PUBLISHED=0
TGZ_FILES=$(ls *.tgz 2>/dev/null || true)
if [ -z "$TGZ_FILES" ]; then
  echo "FAIL: no tarballs to publish (all packs failed)"
  exit 1
fi
for tgz in $TGZ_FILES; do
  echo "Publishing $tgz"
  if PUBLISH_OUTPUT=$(npm publish "$tgz" \
    --registry https://registry.npmjs.org \
    --access public \
    --//registry.npmjs.org/:_authToken="${NPM_TOKEN}" 2>&1); then
    echo "$PUBLISH_OUTPUT"
  else
    status=$?
    echo "$PUBLISH_OUTPUT"
    if echo "$PUBLISH_OUTPUT" | grep -Eqi 'Cannot publish over existing version|previously published versions|EPUBLISHCONFLICT'; then
      echo "WARNING: $tgz already exists on npmjs.org, skipping"
      ALREADY_PUBLISHED=$((ALREADY_PUBLISHED + 1))
    else
      echo "FAIL: npm publish failed for $tgz"
      exit "$status"
    fi
  fi
done

echo ""
WARNINGS=0
[ "$ALREADY_PUBLISHED" -gt 0 ] && WARNINGS=$((WARNINGS + ALREADY_PUBLISHED))
[ "$PACK_FAILURES" -gt 0 ] && WARNINGS=$((WARNINGS + PACK_FAILURES))
if [ "$WARNINGS" -gt 0 ]; then
  echo "=== Done with $ALREADY_PUBLISHED already-published and $PACK_FAILURES pack-skip warning(s) ==="
else
  echo "=== Done ==="
fi
